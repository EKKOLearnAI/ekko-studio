// Executable settlement lifecycle from @deepseek-ai/dsh-acp 0.2.1-rc.2 (MIT).
function internalError$1(message) { return new Error(message) }
function errorChain(error) { return error.message }
function turnEndToStopReason(end) { return end.kind }
export class Session {
  constructor(ctx, agent, modelControl) {
    this.ctx = ctx;
    this.agent = agent;
    this.outputTail = Promise.resolve();
    this.modelControl = modelControl;
  }
	settleAfterQuiescence(inflight) {
		if (inflight.settlementStarted) return;
		inflight.settlementStarted = true;
		(async () => {
			await inflight.admissionDone;
			if (inflight.messageQueued) {
				const subagents = this.ctx.get("subagents");
				const cancelled = inflight.cancellationDone.promise;
				const isCancelled = () => inflight.admissionController.signal.aborted;
				const idleAt = (seq) => this.agent.status === "idle" && this.agent.session.seq === seq;
				while (true) {
					await Promise.race([this.agent.whenIdle(), cancelled]);
					if (isCancelled()) break;
					const idleSeq = this.agent.session.seq;
					const children = await Promise.race([subagents?.waitForChildren(this.agent), cancelled]);
					if (isCancelled()) break;
					if (children || !idleAt(idleSeq)) continue;
					await this.outputTail;
					if (isCancelled() || idleAt(idleSeq)) break;
				}
				if (isCancelled()) await cancelled;
			}
			/* v8 ignore next -- this prompt owns the slot until this exact settlement clears it. */
			if (this.inflight !== inflight) return;
			this.inflight = void 0;
			if (inflight.admissionController.signal.aborted) {
				inflight.resolve("cancelled");
				return;
			}
			if (inflight.outputError !== void 0) {
				inflight.reject(internalError$1(`assistant output delivery failed: ${inflight.outputError.message}`));
				return;
			}
			if (inflight.agentError !== void 0) {
				inflight.reject(internalError$1(`turn failed: ${inflight.agentError.message}`));
				return;
			}
			const end = inflight.endReason;
			if (end === void 0) inflight.resolve("cancelled");
			else if (end.kind === "error") inflight.reject(internalError$1(`turn failed: ${end.error.message}`));
			else inflight.resolve(turnEndToStopReason(end));
		})().catch((error) => {
			if (this.inflight !== inflight) return;
			this.inflight = void 0;
			inflight.reject(internalError$1(`prompt settlement failed: ${errorChain(error)}`));
		});
		/* v8 ignore stop */
	}
}
