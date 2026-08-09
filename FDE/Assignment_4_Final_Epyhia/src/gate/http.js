import { AppError, ValidationError } from "../shared/errors.js";

const MAX_BODY_BYTES = 6 * 1024 * 1024;

export async function readJson(request) {
  const body = await readRaw(request);
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new ValidationError("Request body must be valid JSON");
  }
}

export async function readRaw(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
      throw new ValidationError("Request body exceeds 6 MiB");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function bearer(request) {
  const header = request.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

export function send(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

export function sendError(response, error) {
  const appError =
    error instanceof AppError
      ? error
      : new AppError("An unexpected Action Gate error occurred");
  send(response, appError.status, {
    error: {
      code: appError.code,
      message: appError.message,
      ...(appError.details ? { details: appError.details } : {}),
    },
  });
}
