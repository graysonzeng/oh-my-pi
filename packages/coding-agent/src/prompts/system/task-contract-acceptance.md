{{#each targets}}
Target satisfied: {{{this}}}
{{/each}}
{{#each changes}}
Change observable: {{{this}}}
{{/each}}
{{#each outcomes}}
Outcome: {{{this}}}
{{/each}}
{{#unless hasCandidates}}
Assigned work produces an observable result that can be checked against the task description.
{{/unless}}
