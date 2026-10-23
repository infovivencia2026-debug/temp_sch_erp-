import { connect } from 'cloudflare:sockets'

/* Every outbound TCP connection (SMTP, IMAP) opens here. The integration
   tests put a fake server in globalThis.__erpDial so no test reaches the
   network; in production nothing sets it and this is connect() itself. */

export type Dial = (address: SocketAddress, options?: SocketOptions) => Socket

export function dial(address: SocketAddress, options?: SocketOptions): Socket {
  const fake = (globalThis as { __erpDial?: Dial }).__erpDial
  return (fake ?? connect)(address, options)
}
