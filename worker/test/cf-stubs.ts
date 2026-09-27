/* Stand-ins for the Workers runtime modules, for node --test bundles. Never
   called by the code under test; a call means a test reached the network. */
export function connect(): never { throw new Error('cloudflare:sockets is not available in tests') }
export class DurableObject { constructor(..._a: unknown[]) {} }
