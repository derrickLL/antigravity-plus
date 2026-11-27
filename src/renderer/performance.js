function formatAgyPlusDuration(seconds, live = false) {
    if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '—';
    if (!live && seconds < 60 && Math.round(seconds * 10) < 600) {
        return `${seconds.toFixed(1)}s`;
    }
    const total = live ? Math.floor(seconds) : Math.round(seconds);
    if (total < 60) return `${total}s`;
    if (total < 3600) {
        const minutes = Math.floor(total / 60);
        const secs = total % 60;
        return `${minutes}m ${String(secs).padStart(2, '0')}s`;
    }
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(secs).padStart(2, '0')}s`;
}

function readAgyPlusPerformance(state, now = Date.now(), fallbackStartMs = null) {
    function timestamp(value) {
        if (!value || value.seconds === undefined) return null;
        const milliseconds = Number(value.seconds) * 1000 + Number(value.nanos || 0) / 1e6;
        return Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : null;
    }
    function tokens(value) {
        if (value === undefined || value === null || value === '') return null;
        const count = Number(value);
        return Number.isSafeInteger(count) && count >= 0 ? count : null;
    }
    function isUserTurn(step) {
        if (step?.step?.case !== 'userInput') return false;
        const src = step.metadata?.source;
        if (src === 2 || src === 5 || src === 6) return false;
        if (typeof src === 'string' && /MODEL|SYSTEM/i.test(src)) return false;
        return true;
    }

    const steps = state?.trajectorySlice?.stepsInSlice || [];
    let userIndex = -1;
    for (let index = steps.length - 1; index >= 0; index--) {
        if (isUserTurn(steps[index])) {
            userIndex = index;
            break;
        }
    }
    const user = userIndex >= 0 ? steps[userIndex] : undefined;
    const afterSteps = userIndex >= 0 ? steps.slice(userIndex + 1) : steps;
    const hasTurn = !!user || afterSteps.length > 0;
    const userStart = timestamp(user?.metadata?.createdAt) ?? timestamp(user?.metadata?.startedAt);

    let earliestStepStart = null;
    let lastCompletedEnd = null;
    let latestResponse;
    let completedCalls = 0;
    let modelDurationMs = 0;
    let outputSum = 0;
    let hasOutput = false;
    let responseSum = 0;
    let hasResponse = false;
    let thinkingSum = 0;
    let hasThinking = false;
    let inputSum = 0;
    let hasInput = false;

    for (const step of afterSteps) {
        const meta = step?.metadata;
        const created = timestamp(meta?.createdAt) ?? timestamp(meta?.startedAt);
        if (created !== null && (earliestStepStart === null || created < earliestStepStart)) {
            earliestStepStart = created;
        }
        const finished = timestamp(meta?.finishedGeneratingAt);
        const completed = timestamp(meta?.completedAt);
        const end = finished !== null && completed !== null ? Math.max(finished, completed) : (finished ?? completed);
        if (end !== null && (lastCompletedEnd === null || end > lastCompletedEnd)) {
            lastCompletedEnd = end;
        }
        if (step?.step?.case === 'plannerResponse') {
            latestResponse = step;
            const callFinish = finished ?? completed;
            if (created !== null && callFinish !== null && callFinish >= created) {
                completedCalls++;
                modelDurationMs += (callFinish - created);
                const usage = meta?.modelUsage;
                const out = tokens(usage?.outputTokens);
                const resp = tokens(usage?.responseOutputTokens);
                const think = tokens(usage?.thinkingOutputTokens);
                const inp = tokens(usage?.inputTokens);
                if (out !== null) { outputSum += out; hasOutput = true; }
                if (resp !== null) { responseSum += resp; hasResponse = true; }
                if (think !== null) { thinkingSum += think; hasThinking = true; }
                if (inp !== null) { inputSum += inp; hasInput = true; }
            }
        }
    }

    const fallbackValid = userIndex < 0 && afterSteps.length > 0 &&
        Number.isFinite(fallbackStartMs) && fallbackStartMs > 0 &&
        (earliestStepStart === null || fallbackStartMs <= earliestStepStart);
    const taskStart = userStart ?? (fallbackValid ? fallbackStartMs : earliestStepStart);
    const running = hasTurn && !!state && state.fullyIdle === false;

    let phase;
    let taskEnd = null;
    if (running) {
        if (afterSteps.length === 0) {
            phase = 'Waiting';
        } else {
            const latestMeta = latestResponse?.metadata;
            const latestFinish = timestamp(latestMeta?.finishedGeneratingAt) ?? timestamp(latestMeta?.completedAt);
            const latestVisible = timestamp(latestMeta?.viewableAt);
            if (latestResponse && latestFinish === null) {
                phase = latestVisible === null ? 'Thinking' : 'Generating';
            } else {
                phase = 'Executing';
            }
        }
        if (taskStart !== null && Number.isFinite(now)) {
            if (now >= taskStart) taskEnd = now;
            else if (taskStart - now <= 5000) taskEnd = taskStart;
        }
    } else if (taskStart !== null && lastCompletedEnd !== null && lastCompletedEnd >= taskStart) {
        phase = 'Completed';
        taskEnd = lastCompletedEnd;
    } else if (hasTurn) {
        phase = 'Unavailable';
    } else {
        phase = 'No data';
    }

    const elapsedSeconds = taskStart !== null && taskEnd !== null && taskEnd >= taskStart
        ? (taskEnd - taskStart) / 1000
        : null;
    const modelSeconds = completedCalls > 0 ? modelDurationMs / 1000 : null;

    return {
        phase,
        userStartMs: userIndex >= 0 ? taskStart : userStart,
        modelCalls: completedCalls,
        outputTokens: hasOutput ? outputSum : null,
        responseTokens: hasResponse ? responseSum : null,
        thinkingTokens: hasThinking ? thinkingSum : null,
        inputTokens: hasInput ? inputSum : null,
        elapsedSeconds,
        modelSeconds,
        averageTokensPerSecond: hasOutput && modelSeconds !== null && modelSeconds > 0
            ? outputSum / modelSeconds
            : null
    };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { formatAgyPlusDuration, readAgyPlusPerformance };
}
