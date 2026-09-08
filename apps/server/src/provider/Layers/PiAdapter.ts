import {
  ApprovalRequestId,
  EventId,
  type PiSettings,
  type ProviderApprovalDecision,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  RuntimeRequestId,
  type ThreadId,
  TurnId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  type ProviderAdapterError,
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
  makeAcpTurnDiffUpdatedEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import type * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import { makeAcpNativeLoggerFactory } from "../acp/AcpNativeLogging.ts";
import { applyPiAcpModelSelection, makePiAcpRuntime } from "../acp/PiAcpSupport.ts";
import { parsePermissionRequest } from "../acp/AcpRuntimeModel.ts";
import type { PiAdapterShape } from "../Services/PiAdapter.ts";
import { makeEventNdjsonLogger, type EventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = ProviderDriverKind.make("piAgent");
const PI_RESUME_VERSION = 1 as const;
const PiResumeCursor = Schema.Struct({
  schemaVersion: Schema.Literal(PI_RESUME_VERSION),
  sessionId: Schema.Trimmed.check(Schema.isNonEmpty()),
});
const decodePiResume = Schema.decodeUnknownOption(PiResumeCursor);

export interface PiAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly instanceId?: ProviderInstanceId;
  readonly cancelTimeout?: Duration.Input;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

interface PendingUserInput {
  readonly resolution: Deferred.Deferred<
    | { readonly _tag: "answered"; readonly answers: ProviderUserInputAnswers }
    | { readonly _tag: "cancelled" }
  >;
}

interface PendingInterrupt {
  readonly turnId: TurnId;
  readonly done: Deferred.Deferred<void, ProviderAdapterError>;
}

interface PiSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntime.AcpSessionRuntime["Service"];
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly sessionApprovedOperations: Set<string>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  readonly terminalTurnIds: Set<TurnId>;
  activeTurnId: TurnId | undefined;
  pendingInterrupt: PendingInterrupt | undefined;
  promptsInFlight: number;
  stopped: boolean;
}

interface PiSessionStopOptions {
  readonly errorMessage?: string;
  readonly errorDetail?: unknown;
}

function parsePiResume(raw: unknown): { sessionId: string } | undefined {
  return Option.getOrUndefined(decodePiResume(raw));
}

function selectPermissionOptionId(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: ProviderApprovalDecision,
): string | undefined {
  const preferredKinds =
    decision === "acceptAlways" || decision === "acceptForSession"
      ? (["allow_always", "allow_once"] as const)
      : decision === "accept"
        ? (["allow_once", "allow_always"] as const)
        : (["reject_once", "reject_always"] as const);
  for (const kind of preferredKinds) {
    const optionId = request.options.find((option) => option.kind === kind)?.optionId.trim();
    if (optionId) return optionId;
  }
  return undefined;
}

function selectAutoApprovedPermissionOptionId(
  request: EffectAcpSchema.RequestPermissionRequest,
): string | undefined {
  return selectPermissionOptionId(request, "acceptForSession");
}

function piPermissionOperationKey(
  request: EffectAcpSchema.RequestPermissionRequest,
): string | undefined {
  const rawInput = request.toolCall.rawInput;
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) return undefined;
  if (Reflect.get(rawInput, "method") !== "select") return undefined;
  const title = request.toolCall.title?.trim();
  return title ? stableStringify({ title }) : undefined;
}

function piUserInputQuestions(params: {
  readonly method: string;
  readonly title: string;
  readonly message: string;
  readonly placeholder: string;
  readonly prefill: string;
}): ReadonlyArray<UserInputQuestion> {
  const question = params.message.trim() || params.title.trim() || "Pi needs input.";
  return [
    {
      id: "value",
      header: params.method === "editor" ? "Edit response" : "Your response",
      question,
      options: [],
      multiSelect: false,
    },
  ];
}

function piUserInputValue(answers: ProviderUserInputAnswers): string | undefined {
  const value = answers.value;
  return typeof value === "string" ? value : undefined;
}

function currentModelFromSetup(
  response:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  return response.models?.currentModelId.trim() || undefined;
}

export const makePiAdapter = Effect.fn("makePiAdapter")(function* (
  piSettings: PiSettings,
  options?: PiAdapterLiveOptions,
) {
  const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("piAgent");
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const serverConfig = yield* ServerConfig;
  const crypto = yield* Crypto.Crypto;
  const nativeEventLogger =
    options?.nativeEventLogger ??
    (options?.nativeEventLogPath
      ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
      : undefined);
  const managedNativeEventLogger =
    options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
  const makeAcpNativeLoggers = yield* makeAcpNativeLoggerFactory();

  const sessions = new Map<ThreadId, PiSessionContext>();
  const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
  const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const randomUUIDv4 = crypto.randomUUIDv4.pipe(
    Effect.mapError(
      (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "crypto/randomUUIDv4",
          detail: "Failed to generate Pi runtime identifier.",
          cause,
        }),
    ),
  );
  const makeEventStamp = () =>
    Effect.all({ eventId: Effect.map(randomUUIDv4, EventId.make), createdAt: nowIso });
  const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
    PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

  const getThreadSemaphore = (threadId: string) =>
    SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
      const existing = Option.fromNullishOr(current.get(threadId));
      return Option.match(existing, {
        onNone: () =>
          Semaphore.make(1).pipe(
            Effect.map((semaphore) => {
              const next = new Map(current);
              next.set(threadId, semaphore);
              return [semaphore, next] as const;
            }),
          ),
        onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
      });
    });
  const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
    Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

  const requireSession = (
    threadId: ThreadId,
  ): Effect.Effect<PiSessionContext, ProviderAdapterSessionNotFoundError> => {
    const context = sessions.get(threadId);
    return context && !context.stopped
      ? Effect.succeed(context)
      : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
  };

  const settlePendingApprovals = (context: PiSessionContext) =>
    Effect.gen(function* () {
      const pending = Array.from(context.pendingApprovals.values());
      context.pendingApprovals.clear();
      yield* Effect.forEach(
        pending,
        (request) => Deferred.succeed(request.decision, "cancel").pipe(Effect.ignore),
        { discard: true },
      );
    });

  const settlePendingUserInputs = (context: PiSessionContext) =>
    Effect.gen(function* () {
      const pending = Array.from(context.pendingUserInputs.values());
      context.pendingUserInputs.clear();
      yield* Effect.forEach(
        pending,
        (request) =>
          Deferred.succeed(request.resolution, { _tag: "cancelled" }).pipe(Effect.ignore),
        { discard: true },
      );
    });

  const settlePendingRequests = (context: PiSessionContext) =>
    Effect.all([settlePendingApprovals(context), settlePendingUserInputs(context)], {
      concurrency: "unbounded",
      discard: true,
    });

  const settleTurn = (
    context: PiSessionContext,
    input:
      | { readonly state: "cancelled"; readonly stopReason: string }
      | { readonly state: "failed"; readonly errorMessage: string },
  ) =>
    Effect.gen(function* () {
      const turnId = context.activeTurnId ?? context.session.activeTurnId;
      context.activeTurnId = undefined;
      context.promptsInFlight = 0;
      const { activeTurnId: _activeTurnId, ...readySession } = context.session;
      context.session = {
        ...readySession,
        status: "ready",
        updatedAt: yield* nowIso,
        ...(input.state === "failed" ? { lastError: input.errorMessage } : {}),
      };
      if (!turnId || context.terminalTurnIds.has(turnId)) return;
      context.terminalTurnIds.add(turnId);
      yield* offerRuntimeEvent({
        type: "turn.completed",
        ...(yield* makeEventStamp()),
        provider: PROVIDER,
        threadId: context.threadId,
        turnId,
        payload:
          input.state === "failed"
            ? { state: "failed", errorMessage: input.errorMessage }
            : { state: "cancelled", stopReason: input.stopReason },
      });
    });

  const stopSessionInternal: (
    context: PiSessionContext,
    options?: PiSessionStopOptions,
  ) => Effect.Effect<void, ProviderAdapterRequestError> = (context, options) =>
    Effect.gen(function* () {
      if (context.stopped) return;
      context.stopped = true;
      if (options?.errorMessage) {
        yield* settleTurn(context, { state: "failed", errorMessage: options.errorMessage });
        yield* offerRuntimeEvent({
          type: "runtime.error",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: context.threadId,
          payload: {
            message: options.errorMessage,
            class: "transport_error",
            ...(options.errorDetail !== undefined ? { detail: options.errorDetail } : {}),
          },
        });
      } else {
        yield* settleTurn(context, { state: "cancelled", stopReason: "stopped" });
      }
      if (context.pendingInterrupt) {
        yield* Deferred.succeed(context.pendingInterrupt.done, undefined).pipe(Effect.ignore);
        context.pendingInterrupt = undefined;
      }
      yield* settlePendingRequests(context);
      yield* context.acp.cancel.pipe(Effect.ignore);
      yield* context.acp.drainEvents.pipe(Effect.ignore);
      if (context.notificationFiber) yield* Fiber.interrupt(context.notificationFiber);
      sessions.delete(context.threadId);
      yield* offerRuntimeEvent({
        type: "session.exited",
        ...(yield* makeEventStamp()),
        provider: PROVIDER,
        threadId: context.threadId,
        payload: options?.errorMessage
          ? { reason: options.errorMessage, recoverable: false, exitKind: "error" }
          : { exitKind: "graceful" },
      });
      yield* Scope.close(context.scope, Exit.void).pipe(Effect.ignore);
    });

  const applyModelSelection = (
    context: Pick<PiSessionContext, "acp" | "threadId">,
    modelSelection:
      | {
          readonly model: string;
          readonly options?: ReadonlyArray<{
            readonly id: string;
            readonly value: string | boolean;
          }> | null;
        }
      | undefined,
  ) =>
    modelSelection
      ? applyPiAcpModelSelection({
          runtime: context.acp,
          model: modelSelection.model,
          selections: modelSelection.options,
          mapError: ({ cause, step }) =>
            mapAcpToAdapterError(
              PROVIDER,
              context.threadId,
              step === "set-model" ? "session/set_model" : "session/set_config_option",
              cause,
            ),
        })
      : Effect.void;

  const startSession: PiAdapterShape["startSession"] = (input) =>
    withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          });
        }
        if (!input.cwd?.trim()) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "cwd is required and must be non-empty.",
          });
        }

        const cwd = path.resolve(input.cwd.trim());
        const modelSelection =
          input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
        const existing = sessions.get(input.threadId);
        if (existing && !existing.stopped) yield* stopSessionInternal(existing);

        const sessionScope = yield* Scope.make("sequential");
        let sessionScopeTransferred = false;
        yield* Effect.addFinalizer(() =>
          sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
        );
        const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
        const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
        const resumeSessionId = parsePiResume(input.resumeCursor)?.sessionId;
        let context!: PiSessionContext;

        const acp = yield* makePiAcpRuntime({
          piSettings,
          ...(options?.environment ? { environment: options.environment } : {}),
          childProcessSpawner,
          cwd,
          ...(resumeSessionId ? { resumeSessionId } : {}),
          clientInfo: { name: "t3-code", version: "0.0.0" },
          runtimeDirectory: path.join(serverConfig.stateDir, "providers", "pi"),
          runtimeMode: input.runtimeMode,
          ...(options?.cancelTimeout ? { cancelTimeout: options.cancelTimeout } : {}),
          ...makeAcpNativeLoggers({
            nativeEventLogger,
            provider: PROVIDER,
            threadId: input.threadId,
          }),
        }).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.provideService(Scope.Scope, sessionScope),
          Effect.mapError(
            (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: cause.message,
                cause,
              }),
          ),
        );

        const started = yield* Effect.gen(function* () {
          yield* acp.handleExtRequest(
            "t3/pi/user_input",
            Schema.Struct({
              sessionId: Schema.String,
              requestId: Schema.String,
              method: Schema.Literals(["input", "editor"]),
              title: Schema.String,
              message: Schema.String,
              placeholder: Schema.String,
              prefill: Schema.String,
            }),
            (params) =>
              Effect.gen(function* () {
                const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
                const runtimeRequestId = RuntimeRequestId.make(requestId);
                const resolution = yield* Deferred.make<
                  | { readonly _tag: "answered"; readonly answers: ProviderUserInputAnswers }
                  | { readonly _tag: "cancelled" }
                >();
                pendingUserInputs.set(requestId, { resolution });
                yield* offerRuntimeEvent({
                  type: "user-input.requested",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId: context?.activeTurnId,
                  requestId: runtimeRequestId,
                  payload: { questions: piUserInputQuestions(params) },
                  raw: {
                    source: "acp.pi.extension",
                    method: "t3/pi/user_input",
                    payload: params,
                  },
                });
                const resolved = yield* Deferred.await(resolution);
                pendingUserInputs.delete(requestId);
                const answers = resolved._tag === "answered" ? resolved.answers : {};
                yield* offerRuntimeEvent({
                  type: "user-input.resolved",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId: context?.activeTurnId,
                  requestId: runtimeRequestId,
                  payload: { answers },
                  raw: {
                    source: "acp.pi.extension",
                    method: "t3/pi/user_input/resolved",
                    payload: params,
                  },
                });
                const value = resolved._tag === "answered" ? piUserInputValue(answers) : undefined;
                return value === undefined ? { cancelled: true } : { value };
              }).pipe(
                Effect.mapError(
                  (cause) =>
                    new EffectAcpErrors.AcpTransportError({
                      detail: "Failed to process Pi user-input request.",
                      cause,
                    }),
                ),
              ),
          );
          yield* acp.handleRequestPermission((params) =>
            Effect.gen(function* () {
              const permissionRequest = parsePermissionRequest(params);
              const operationKey = piPermissionOperationKey(params);
              const alreadyApproved =
                operationKey !== undefined && context?.sessionApprovedOperations.has(operationKey);
              const autoApproveFileChange =
                input.runtimeMode === "auto-accept-edits" && permissionRequest.kind === "edit";
              if (input.runtimeMode === "full-access" || autoApproveFileChange || alreadyApproved) {
                const optionId =
                  autoApproveFileChange || alreadyApproved
                    ? selectPermissionOptionId(params, "accept")
                    : selectAutoApprovedPermissionOptionId(params);
                if (optionId) return { outcome: { outcome: "selected" as const, optionId } };
              }

              const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
              const runtimeRequestId = RuntimeRequestId.make(requestId);
              const decision = yield* Deferred.make<ProviderApprovalDecision>();
              pendingApprovals.set(requestId, { decision });
              yield* offerRuntimeEvent(
                makeAcpRequestOpenedEvent({
                  stamp: yield* makeEventStamp(),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId: context?.activeTurnId,
                  requestId: runtimeRequestId,
                  permissionRequest,
                  detail: permissionRequest.detail ?? "Pi requested confirmation.",
                  args: params,
                  source: "acp.jsonrpc",
                  method: "session/request_permission",
                  rawPayload: params,
                }),
              );
              const resolved = yield* Deferred.await(decision);
              pendingApprovals.delete(requestId);
              yield* offerRuntimeEvent(
                makeAcpRequestResolvedEvent({
                  stamp: yield* makeEventStamp(),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId: context?.activeTurnId,
                  requestId: runtimeRequestId,
                  permissionRequest,
                  decision: resolved,
                }),
              );
              const optionId =
                resolved === "cancel" ? undefined : selectPermissionOptionId(params, resolved);
              if (resolved === "acceptForSession" && optionId && operationKey !== undefined) {
                context?.sessionApprovedOperations.add(operationKey);
              }
              return optionId
                ? { outcome: { outcome: "selected" as const, optionId } }
                : { outcome: { outcome: "cancelled" as const } };
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new EffectAcpErrors.AcpTransportError({
                    detail: "Failed to process Pi ACP permission request.",
                    cause,
                  }),
              ),
            ),
          );
          return yield* acp.start();
        }).pipe(
          Effect.mapError((error) =>
            mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
          ),
        );

        yield* applyModelSelection({ acp, threadId: input.threadId }, modelSelection);
        const model = modelSelection?.model ?? currentModelFromSetup(started.sessionSetupResult);
        const now = yield* nowIso;
        const session: ProviderSession = {
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          cwd,
          ...(model ? { model } : {}),
          threadId: input.threadId,
          resumeCursor: { schemaVersion: PI_RESUME_VERSION, sessionId: started.sessionId },
          createdAt: now,
          updatedAt: now,
        };
        context = {
          threadId: input.threadId,
          session,
          scope: sessionScope,
          acp,
          notificationFiber: undefined,
          pendingApprovals,
          pendingUserInputs,
          sessionApprovedOperations: new Set(),
          turns: [],
          terminalTurnIds: new Set(),
          activeTurnId: undefined,
          pendingInterrupt: undefined,
          promptsInFlight: 0,
          stopped: false,
        };

        context.notificationFiber = yield* Stream.runDrain(
          Stream.mapEffect(acp.getEvents(), (event) =>
            Effect.gen(function* () {
              switch (event._tag) {
                case "EventStreamBarrier":
                  yield* Deferred.succeed(event.acknowledge, undefined);
                  return;
                case "ModeChanged":
                  return;
                case "AssistantItemStarted":
                case "AssistantItemCompleted":
                  yield* offerRuntimeEvent(
                    makeAcpAssistantItemEvent({
                      stamp: yield* makeEventStamp(),
                      provider: PROVIDER,
                      threadId: context.threadId,
                      turnId: context.activeTurnId,
                      itemId: event.itemId,
                      itemType: event.itemType,
                      lifecycle:
                        event._tag === "AssistantItemStarted" ? "item.started" : "item.completed",
                    }),
                  );
                  return;
                case "PlanUpdated":
                  yield* offerRuntimeEvent(
                    makeAcpPlanUpdatedEvent({
                      stamp: yield* makeEventStamp(),
                      provider: PROVIDER,
                      threadId: context.threadId,
                      turnId: context.activeTurnId,
                      payload: event.payload,
                      source: "acp.jsonrpc",
                      method: "session/update",
                      rawPayload: event.rawPayload,
                    }),
                  );
                  return;
                case "ToolCallUpdated":
                  yield* offerRuntimeEvent(
                    makeAcpToolCallEvent({
                      stamp: yield* makeEventStamp(),
                      provider: PROVIDER,
                      threadId: context.threadId,
                      turnId: context.activeTurnId,
                      lifecycle: event.lifecycle,
                      toolCall: event.toolCall,
                      rawPayload: event.rawPayload,
                    }),
                  );
                  return;
                case "ToolCallContentDelta":
                  yield* offerRuntimeEvent(
                    makeAcpContentDeltaEvent({
                      stamp: yield* makeEventStamp(),
                      provider: PROVIDER,
                      threadId: context.threadId,
                      turnId: context.activeTurnId,
                      itemId: event.itemId,
                      streamKind: event.streamKind,
                      text: event.text,
                      rawPayload: event.rawPayload,
                    }),
                  );
                  return;
                case "TurnDiffUpdated":
                  yield* offerRuntimeEvent(
                    makeAcpTurnDiffUpdatedEvent({
                      stamp: yield* makeEventStamp(),
                      provider: PROVIDER,
                      threadId: context.threadId,
                      turnId: context.activeTurnId,
                      itemId: event.itemId,
                      unifiedDiff: event.unifiedDiff,
                      rawPayload: event.rawPayload,
                    }),
                  );
                  return;
                case "ConfigOptionsUpdated":
                  yield* offerRuntimeEvent({
                    type: "session.configured",
                    ...(yield* makeEventStamp()),
                    provider: PROVIDER,
                    threadId: context.threadId,
                    turnId: context.activeTurnId,
                    payload: { config: { options: event.configOptions } },
                    raw: {
                      source: "acp.jsonrpc",
                      method: "session/update",
                      payload: event.rawPayload,
                    },
                  });
                  return;
                case "RuntimeWarning":
                  yield* offerRuntimeEvent({
                    type: "runtime.warning",
                    ...(yield* makeEventStamp()),
                    provider: PROVIDER,
                    threadId: context.threadId,
                    turnId: context.activeTurnId,
                    payload: { message: event.message },
                    raw: {
                      source: "acp.jsonrpc",
                      method: "session/update",
                      payload: event.rawPayload,
                    },
                  });
                  return;
                case "ContentDelta":
                  yield* offerRuntimeEvent(
                    makeAcpContentDeltaEvent({
                      stamp: yield* makeEventStamp(),
                      provider: PROVIDER,
                      threadId: context.threadId,
                      turnId: context.activeTurnId,
                      ...(event.itemId ? { itemId: event.itemId } : {}),
                      streamKind: event.streamKind,
                      text: event.text,
                      rawPayload: event.rawPayload,
                    }),
                  );
                  if (
                    event.streamKind === "assistant_text" &&
                    (/^Retrying(?:\s|\.|$)/.test(event.text.trim()) ||
                      event.text.trim() === "Retry finished, resuming.")
                  ) {
                    yield* offerRuntimeEvent({
                      type: "runtime.warning",
                      ...(yield* makeEventStamp()),
                      provider: PROVIDER,
                      threadId: context.threadId,
                      turnId: context.activeTurnId,
                      payload: { message: event.text.trim() },
                      raw: {
                        source: "acp.jsonrpc",
                        method: "session/update",
                        payload: event.rawPayload,
                      },
                    });
                  }
                  return;
              }
            }),
          ),
        ).pipe(
          Effect.catch((cause) =>
            stopSessionInternal(context, {
              errorMessage: "Pi ACP emitted malformed output.",
              errorDetail: cause,
            }).pipe(
              Effect.catch((stopCause) =>
                Effect.logError("Failed to stop Pi after a runtime notification error.", {
                  cause: stopCause,
                }),
              ),
            ),
          ),
          Effect.forkIn(context.scope),
        );

        sessions.set(input.threadId, context);
        sessionScopeTransferred = true;
        yield* offerRuntimeEvent({
          type: "session.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          payload: { resume: started.initializeResult },
        });
        yield* offerRuntimeEvent({
          type: "session.state.changed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          payload: { state: "ready", reason: "Pi ACP session ready" },
        });
        yield* offerRuntimeEvent({
          type: "thread.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          payload: { providerThreadId: started.sessionId },
        });
        return session;
      }).pipe(Effect.scoped),
    );

  const sendTurn: PiAdapterShape["sendTurn"] = (input) =>
    Effect.gen(function* () {
      const context = yield* requireSession(input.threadId);
      if (context.pendingInterrupt) yield* Deferred.await(context.pendingInterrupt.done);
      const steeringTurnId = context.promptsInFlight > 0 ? context.activeTurnId : undefined;
      const turnId = steeringTurnId ?? TurnId.make(yield* randomUUIDv4);
      const turnAdmitted = yield* Ref.make(false);
      const turnSettled = yield* Ref.make(false);
      context.promptsInFlight += 1;

      return yield* Effect.gen(function* () {
        const modelSelection =
          input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
        yield* applyModelSelection(context, modelSelection);
        context.activeTurnId = turnId;
        context.session = {
          ...context.session,
          status: "running",
          activeTurnId: turnId,
          ...(modelSelection?.model ? { model: modelSelection.model } : {}),
          updatedAt: yield* nowIso,
        };
        yield* Ref.set(turnAdmitted, true);
        if (!steeringTurnId) {
          yield* offerRuntimeEvent({
            type: "turn.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            turnId,
            payload: { model: context.session.model },
          });
        }

        const prompt: Array<EffectAcpSchema.ContentBlock> = [];
        if (input.input?.trim()) prompt.push({ type: "text", text: input.input.trim() });
        for (const attachment of input.attachments ?? []) {
          if (attachment.type !== "image") continue;
          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          });
          if (!attachmentPath) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/prompt",
              detail: `Invalid attachment id '${attachment.id}'.`,
            });
          }
          const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session/prompt",
                  detail: cause.message,
                  cause,
                }),
            ),
          );
          prompt.push({
            type: "image",
            data: Buffer.from(bytes).toString("base64"),
            mimeType: attachment.mimeType,
          });
        }
        if (prompt.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Turn requires non-empty text or attachments.",
          });
        }

        const result = yield* context.acp
          .prompt({ prompt })
          .pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error),
            ),
          );
        if (
          !sessions.has(input.threadId) ||
          context.stopped ||
          context.terminalTurnIds.has(turnId)
        ) {
          yield* Ref.set(turnSettled, true);
          return {
            threadId: input.threadId,
            turnId,
            resumeCursor: context.session.resumeCursor,
          };
        }
        yield* context.acp.drainEvents;
        if (context.stopped || context.terminalTurnIds.has(turnId)) {
          yield* Ref.set(turnSettled, true);
          return {
            threadId: input.threadId,
            turnId,
            resumeCursor: context.session.resumeCursor,
          };
        }
        const turn = context.turns.find((candidate) => candidate.id === turnId);
        if (turn) turn.items.push({ prompt, result });
        else context.turns.push({ id: turnId, items: [{ prompt, result }] });

        if (context.promptsInFlight === 1) {
          context.terminalTurnIds.add(turnId);
          context.activeTurnId = undefined;
          const {
            activeTurnId: _activeTurnId,
            lastError: _lastError,
            ...readySession
          } = context.session;
          context.session = { ...readySession, status: "ready", updatedAt: yield* nowIso };
          yield* offerRuntimeEvent({
            type: "turn.completed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            turnId,
            payload: {
              state: result.stopReason === "cancelled" ? "cancelled" : "completed",
              stopReason: result.stopReason ?? null,
            },
          });
        }
        yield* Ref.set(turnSettled, true);
        return {
          threadId: input.threadId,
          turnId,
          resumeCursor: context.session.resumeCursor,
        };
      }).pipe(
        Effect.catch((error: ProviderAdapterError) =>
          Effect.gen(function* () {
            const turnWasAdmitted = yield* Ref.get(turnAdmitted);
            const turnWasSettled = yield* Ref.get(turnSettled);
            if (error._tag === "ProviderAdapterSessionClosedError") {
              yield* stopSessionInternal(context, {
                errorMessage: error.message,
                errorDetail: error,
              });
              yield* Ref.set(turnSettled, true);
            } else if (turnWasAdmitted && !turnWasSettled) {
              yield* settleTurn(context, { state: "failed", errorMessage: error.message });
              yield* Ref.set(turnSettled, true);
            }
            return yield* error;
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            context.promptsInFlight = Math.max(0, context.promptsInFlight - 1);
          }),
        ),
      );
    });

  const interruptTurn: PiAdapterShape["interruptTurn"] = (threadId, turnId) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      const activeTurnId = context.activeTurnId ?? context.session.activeTurnId;
      if (!activeTurnId || context.terminalTurnIds.has(activeTurnId)) return;
      if (turnId !== undefined && turnId !== activeTurnId) return;
      if (context.pendingInterrupt) {
        return context.pendingInterrupt.turnId === activeTurnId
          ? yield* Deferred.await(context.pendingInterrupt.done)
          : undefined;
      }
      const done = yield* Deferred.make<void, ProviderAdapterError>();
      const pending = { turnId: activeTurnId, done } satisfies PendingInterrupt;
      context.pendingInterrupt = pending;
      return yield* Effect.gen(function* () {
        yield* settlePendingRequests(context);
        yield* context.acp.cancel.pipe(
          Effect.mapError((error) =>
            mapAcpToAdapterError(PROVIDER, threadId, "session/cancel", error),
          ),
        );
        yield* context.acp.drainEvents;
        yield* settleTurn(context, { state: "cancelled", stopReason: "cancelled" });
      }).pipe(
        Effect.catch((error: ProviderAdapterError) =>
          stopSessionInternal(context, {
            errorMessage: error.message,
            errorDetail: error,
          }).pipe(
            Effect.catch((stopError) =>
              Effect.logError("Failed to stop Pi after cancellation failed.", {
                cause: stopError,
              }),
            ),
            Effect.andThen(Effect.fail(error)),
          ),
        ),
        Effect.tap(() => Deferred.succeed(done, undefined)),
        Effect.tapCause((cause) => Deferred.failCause(done, cause)),
        Effect.ensuring(
          Effect.sync(() => {
            if (context.pendingInterrupt === pending) context.pendingInterrupt = undefined;
          }),
        ),
      );
    });
  const respondToRequest: PiAdapterShape["respondToRequest"] = (threadId, requestId, decision) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      const pending = context.pendingApprovals.get(requestId);
      if (!pending) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session/request_permission",
          detail: `Unknown pending approval request: ${requestId}`,
        });
      }
      yield* Deferred.succeed(pending.decision, decision);
    });
  const respondToUserInput: PiAdapterShape["respondToUserInput"] = (threadId, requestId, answers) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      const pending = context.pendingUserInputs.get(requestId);
      if (!pending) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "t3/pi/user_input",
          detail: `Unknown pending user-input request: ${requestId}`,
        });
      }
      yield* Deferred.succeed(pending.resolution, { _tag: "answered", answers });
    });
  const readThread: PiAdapterShape["readThread"] = (threadId) =>
    Effect.map(requireSession(threadId), (context) => ({ threadId, turns: context.turns }));
  const rollbackThread: PiAdapterShape["rollbackThread"] = (threadId, numTurns) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      if (!Number.isInteger(numTurns) || numTurns < 1) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue: "numTurns must be an integer >= 1.",
        });
      }
      context.turns.splice(Math.max(0, context.turns.length - numTurns));
      return { threadId, turns: context.turns };
    });
  const stopSession: PiAdapterShape["stopSession"] = (threadId) =>
    withThreadLock(threadId, Effect.flatMap(requireSession(threadId), stopSessionInternal));
  const listSessions: PiAdapterShape["listSessions"] = () =>
    Effect.sync(() => Array.from(sessions.values(), (context) => ({ ...context.session })));
  const hasSession: PiAdapterShape["hasSession"] = (threadId) =>
    Effect.sync(() => {
      const context = sessions.get(threadId);
      return context !== undefined && !context.stopped;
    });
  const stopAll: PiAdapterShape["stopAll"] = () =>
    Effect.forEach(sessions.values(), (context) => stopSessionInternal(context), { discard: true });

  yield* Effect.addFinalizer(() =>
    stopAll().pipe(
      Effect.catch((cause) => Effect.logError("Failed to stop Pi sessions.", { cause })),
      Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
      Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
    ),
  );

  return {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "in-session" },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    readThread,
    rollbackThread,
    stopSession,
    listSessions,
    hasSession,
    stopAll,
    streamEvents: Stream.fromPubSub(runtimeEventPubSub),
  } satisfies PiAdapterShape;
});
