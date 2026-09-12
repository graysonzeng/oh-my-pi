Role: {{role}}
Task: {{taskClass}}
Goal: {{goal}}
{{#if hasConstraints}}

Constraints:
{{#each constraints}}
- {{this}}
{{/each}}
{{/if}}
{{#if hasAcceptance}}

Acceptance:
{{#each acceptance}}
- {{this}}
{{/each}}
{{/if}}
{{#if hasCompletion}}

Completion:
{{#each completion}}
- {{this}}
{{/each}}
{{/if}}
