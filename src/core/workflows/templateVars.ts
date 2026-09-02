export type TemplateContext = {
	input?: string;
	sessionId?: string;
	journalPath?: string;
};

/**
 * Substitute template variables in a text string.
 * Used by all three prompt pipelines: user prompt, continue prompt, system prompt.
 *
 * `{trackerPath}` is the pre-0.6 spelling of `{journalPath}` (#185); it is
 * substituted identically for one release and removed in 0.7.0.
 */
export function substituteVariables(
	text: string,
	ctx: TemplateContext,
): string {
	let result = text;
	if (ctx.input !== undefined) {
		result = result.replaceAll('{input}', ctx.input);
	}
	if (ctx.sessionId !== undefined) {
		result = result.replaceAll('{sessionId}', ctx.sessionId);
		result = result.replaceAll('<session_id>', ctx.sessionId);
	}
	if (ctx.journalPath !== undefined) {
		result = result.replaceAll('{journalPath}', ctx.journalPath);
		result = result.replaceAll('{trackerPath}', ctx.journalPath);
	}
	return result;
}
