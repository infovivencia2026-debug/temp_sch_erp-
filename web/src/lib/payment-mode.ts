/* How a payment mode reads on screen ("upi" -> "UPI"). One list for the
   counter, Student 360 and the reports. */
export const MODE_LABEL: Record<string, string> = {
  cash: 'Cash', upi: 'UPI', card: 'Card', neft: 'NEFT / IMPS / RTGS', netbanking: 'Net banking', cheque: 'Cheque', dd: 'Demand draft',
  wallet: 'Adjust from advance', adjustment: 'Adjustment', online: 'Online',
}
export const modeName = (m: string) => MODE_LABEL[m] ?? (m ? m[0].toUpperCase() + m.slice(1) : '-')
