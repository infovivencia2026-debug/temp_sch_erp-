import type { Router } from '../router'
import { registerInfirmary } from './ops/infirmary'
import { registerDigitalLibrary } from './ops/digital_library'
import { registerLibrary } from './ops/library'
import { registerTransport } from './ops/transport'
import { registerTransportOffice } from './ops/transport_office'
import { registerHostel } from './ops/hostel'
import { registerInventory } from './ops/inventory'

/* Port of the /ops group in internal/api/api.go (lines 1302-1381): the
   library, the digital library, the infirmary, transport, hostel and
   inventory. One sub-file per Go handler file group; the mount order
   matches the Go route table so literal paths win over {id} patterns. */
export function registerOps(r: Router): void {
  registerInfirmary(r)
  registerDigitalLibrary(r)
  registerLibrary(r)
  registerTransport(r)
  registerTransportOffice(r)
  registerHostel(r)
  registerInventory(r)
}
