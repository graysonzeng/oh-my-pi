/**
 * Tiny/local conservative tool surface: authored on the `tiny-local-surface`
 * catalog axis so contracted hosts (`tiny`, `local`, `ollama`, `lmstudio`,
 * canonical `lm-studio`) declare the fact instead of the model-policy
 * compiler guessing from provider/model/api strings.
 *
 * Resolved through the cascade when deriving ModelFacts (not baked onto
 * `Model`): bundled rows are frozen by the generator, and the flag is read
 * once per facts derivation.
 */
import { resolveCascade } from "./cascade";
import { classifyModel } from "./taxonomy";

/** Input identity for {@link resolveTinyLocalSurface}; catalog Model or test doubles. */
export interface TinyLocalSurfaceTarget {
	provider: string;
	api: string;
	model: string;
	reasoning?: boolean;
}

/**
 * Whether this deployment imposes the tiny/local conservative tool surface.
 * Unassigned cascade value is false. Classification is lenient so discovery
 * and shadow identities still resolve provider-scoped host rules.
 */
export function resolveTinyLocalSurface(target: TinyLocalSurfaceTarget): boolean {
	const identity = classifyModel(target.provider, target.model, { lenient: true });
	return (
		resolveCascade({
			provider: target.provider,
			api: target.api,
			class: identity.class,
			model: target.model,
			reasoning: Boolean(target.reasoning),
			...(identity.family !== undefined && { family: identity.family }),
			...(identity.revision !== undefined && { revision: identity.revision }),
		}).catalog.tinyLocalSurface === true
	);
}
