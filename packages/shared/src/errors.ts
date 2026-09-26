/**
 * Domain errors carry a stable machine code (used by the API and the UI to pick a translated
 * message) and an HTTP-ish status hint. Business rules throw these; transport layers map them.
 */
export type DomainErrorCode =
  | 'FORBIDDEN'
  | 'SELF_ACTION_FORBIDDEN'
  | 'ROLE_RANK_TOO_HIGH'
  | 'LAST_OWNER'
  | 'INVALID_TRANSITION'
  | 'COMMENT_REQUIRED'
  | 'FILE_REQUIRED'
  | 'NOT_FOUND'
  | 'VALIDATION';

const STATUS_BY_CODE: Record<DomainErrorCode, number> = {
  FORBIDDEN: 403,
  SELF_ACTION_FORBIDDEN: 403,
  ROLE_RANK_TOO_HIGH: 403,
  LAST_OWNER: 409,
  INVALID_TRANSITION: 409,
  COMMENT_REQUIRED: 422,
  FILE_REQUIRED: 422,
  NOT_FOUND: 404,
  VALIDATION: 422,
};

export class DomainError extends Error {
  readonly status: number;

  constructor(
    readonly code: DomainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DomainError';
    this.status = STATUS_BY_CODE[code];
  }
}
