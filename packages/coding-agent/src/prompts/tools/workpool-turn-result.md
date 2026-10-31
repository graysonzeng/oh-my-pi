Pool `{{pool}}` · agent `{{agent}}` · batch `{{batch}}` {{status}} ({{count}} item{{#if multiple}}s{{/if}}):
{{#each items}}- [{{id}}] {{status}} — {{text}}
{{/each}}
{{#if parentIntegrateDecision}}Parent integrate: {{parentIntegrateDecision.classification}} / {{parentIntegrateDecision.action}}{{#if parentIntegrateDecision.reasons}} ({{parentIntegrateDecision.reasons}}){{/if}}{{#if parentIntegrateDecision.boundToWorkspaceVersion}} · bound {{parentIntegrateDecision.boundToWorkspaceVersion}}{{/if}} · finalAccepted=false
{{/if}}{{output}}
{{#if remaining}}{{remaining}} item(s) still queued or running in this pool.{{else}}Pool queue drained.{{/if}} Transcript: history://{{agent}} · full output: agent://{{agent}}
