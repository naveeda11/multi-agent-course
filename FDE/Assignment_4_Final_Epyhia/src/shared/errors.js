export class AppError extends Error {
  constructor(message, { code = "INTERNAL_ERROR", status = 500, details } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class ValidationError extends AppError {
  constructor(message, details) {
    super(message, { code: "VALIDATION_ERROR", status: 400, details });
  }
}

export class AuthenticationError extends AppError {
  constructor(message = "A valid capability handle is required") {
    super(message, { code: "UNAUTHENTICATED", status: 401 });
  }
}

export class AuthorizationError extends AppError {
  constructor(message = "The capability does not authorize this action") {
    super(message, { code: "FORBIDDEN", status: 403 });
  }
}

export class ApprovalRequiredError extends AppError {
  constructor(message = "The action requires payload-bound administrator approval") {
    super(message, { code: "APPROVAL_REQUIRED", status: 409 });
  }
}

export class ConflictError extends AppError {
  constructor(message, details) {
    super(message, { code: "CONFLICT", status: 409, details });
  }
}

export class NotFoundError extends AppError {
  constructor(message) {
    super(message, { code: "NOT_FOUND", status: 404 });
  }
}

export class ProviderError extends AppError {
  constructor(message, details) {
    super(message, { code: "PROVIDER_ERROR", status: 502, details });
  }
}
