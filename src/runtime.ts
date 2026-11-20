import { ConfigurationError } from './errors.ts';

interface RuntimeScope {
  window?: unknown;
  document?: unknown;
  process?: { versions?: { node?: string } };
}

/**
 * Refuse a page-like runtime. This does not remove an API key from a bundle.
 */
export function assertServerRuntime(scope: RuntimeScope = globalThis): void {
  if (scope.window !== undefined && scope.document !== undefined) {
    throw new ConfigurationError(
      'MailBlaze cannot run where window and document are both present. Call the API from Node.js.',
    );
  }

  if (typeof scope.process?.versions?.node !== 'string' || scope.process.versions.node.length === 0) {
    throw new ConfigurationError('MailBlaze requires Node.js.');
  }
}
