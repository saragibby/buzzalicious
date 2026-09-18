import {
  classifyPlatformError,
  type PlatformError,
  type PublishErrorClass,
} from '../publish.errors';

/**
 * Meta Graph error translation.
 *
 * ## Why codes and not statuses
 *
 * Graph answers a great many different problems with `HTTP 400`. A revoked token, a
 * missing app permission, a malformed parameter and a duplicate post are all 400s, and
 * our taxonomy needs to tell them apart: one means reconnect this account, one means fix
 * the app's permissions, one means edit the post, one means do nothing. Classifying on
 * status alone collapses the four into `VALIDATION`, and the UI then tells everybody to
 * edit their post.
 *
 * So the numeric `code`/`error_subcode` pair is the primary signal — it is the only part
 * of a Graph error that is stable and documented. It is handed to `classifyPlatformError`
 * as an `errorClass` rather than turned into a `PlatformError` here, so Meta does not get
 * a private classification path: there is still one table deciding what a class means for
 * retries and one deciding what the client is told.
 */

/** The envelope every Graph error arrives in. */
export interface GraphErrorBody {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    error_user_title?: string;
    error_user_msg?: string;
    fbtrace_id?: string;
  };
}

/**
 * Graph error codes we can act on, mapped to our classes.
 *
 * Deliberately not exhaustive. An unmapped code falls through to the message rules and
 * then the status, which is the right behaviour for a code we have never seen — guessing
 * a class for an unknown code is worse than admitting we do not know.
 */
export const META_CODE_CLASSES: Readonly<Record<number, PublishErrorClass>> = {
  // OAuthException. The token is the problem: this account, not the app.
  190: 'AUTH',
  // "Permissions error" / "Requires extended permission". The client's *app* was never
  // approved for what we need, so every account minted by this credential is affected and
  // one action by the client fixes all of them. This is the code that makes the whole
  // table worth having — as a plain 400 it would read as "edit your post".
  10: 'CREDENTIAL',
  200: 'CREDENTIAL',
  // Temporary infrastructure problems; documented by Meta as "retry later".
  1: 'TRANSIENT',
  2: 'TRANSIENT',
  // Throttling, in its several flavours: app, user, page, custom.
  4: 'TRANSIENT',
  17: 'TRANSIENT',
  32: 'TRANSIENT',
  613: 'TRANSIENT',
  // Application/user publishing limits: these clear on a window measured in hours, not
  // seconds, so an exponential backoff would burn every retry the job has.
  341: 'QUOTA',
  9: 'QUOTA',
  // Invalid parameter. The post is wrong; retrying it unchanged cannot help.
  100: 'VALIDATION',
  // Duplicate status message.
  506: 'VALIDATION',
  // Temporarily blocked for policy violations.
  368: 'POLICY',
};

/**
 * Subcodes that refine their parent code.
 *
 * Only `190` needs this so far, and only for the message: all of these are `AUTH`, so none
 * changes a verdict today. They are here because "the user removed the app" and "the
 * password changed" send a client to two different places, and a single "reconnect this
 * account" for both wastes their time.
 */
export const META_SUBCODE_NOTES: Readonly<Record<number, string>> = {
  458: 'the user removed the app from their account',
  459: 'the user must log in and clear a checkpoint',
  460: 'the account password changed, invalidating this token',
  463: 'the access token expired',
  467: 'the access token is no longer valid',
};

export interface MetaFailureContext {
  readonly platform: 'FACEBOOK' | 'INSTAGRAM' | 'THREADS';
  readonly status?: number;
  readonly body?: unknown;
  readonly cause?: unknown;
}

/** Pull the Graph error envelope out of a parsed body, if it is there. */
export function graphError(body: unknown): NonNullable<GraphErrorBody['error']> | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const error = (body as GraphErrorBody).error;
  if (typeof error !== 'object' || error === null) return undefined;
  return error;
}

/** Classify a failed Graph call. */
export function classifyMetaError(context: MetaFailureContext): PlatformError {
  const error = graphError(context.body);
  const code = typeof error?.code === 'number' ? error.code : undefined;
  const subcode = typeof error?.error_subcode === 'number' ? error.error_subcode : undefined;

  // `error_user_msg` is Meta's own user-facing text and is more useful than the developer
  // message when it exists. It still never reaches a client except through the POLICY
  // path — see `classifyPlatformError`.
  const upstream =
    (typeof error?.error_user_msg === 'string' ? error.error_user_msg : undefined) ??
    (typeof error?.message === 'string' ? error.message : undefined) ??
    'Unknown Graph API error';

  const note = subcode === undefined ? undefined : META_SUBCODE_NOTES[subcode];

  return classifyPlatformError({
    platform: context.platform,
    status: context.status,
    code,
    message: note ? `${upstream} (${note})` : upstream,
    errorClass: code === undefined ? undefined : META_CODE_CLASSES[code],
    cause: context.cause ?? context.body,
  });
}
