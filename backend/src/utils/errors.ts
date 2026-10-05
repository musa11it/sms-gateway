export interface FieldError {
  field: string;
  message: string;
}

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly errors?: FieldError[],
  ) {
    super(message);
    this.name = 'AppError';
  }

  static badRequest(message: string, code = 'BAD_REQUEST', errors?: FieldError[]) {
    return new AppError(400, code, message, errors);
  }
  static unauthorized(message = 'Authentication required', code = 'UNAUTHENTICATED') {
    return new AppError(401, code, message);
  }
  static forbidden(message = 'You do not have permission to perform this action', code = 'FORBIDDEN') {
    return new AppError(403, code, message);
  }
  static notFound(resource = 'Resource', code = 'NOT_FOUND') {
    return new AppError(404, code, `${resource} not found`);
  }
  static conflict(message: string, code = 'CONFLICT') {
    return new AppError(409, code, message);
  }
  static unprocessable(message: string, code = 'UNPROCESSABLE', errors?: FieldError[]) {
    return new AppError(422, code, message, errors);
  }
  static paymentRequired(message: string, code = 'INSUFFICIENT_CREDITS') {
    return new AppError(402, code, message);
  }
}
