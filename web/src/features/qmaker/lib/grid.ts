/** Final grid: columns, and for each cell (row-major) which child goes there. */
export function optionGrid(count: number, cols: number, order: 'across' | 'down') {
  cols = Math.max(1, Math.min(cols, count || 1))
  const rows = Math.ceil(count / cols)
  const cells: (number | null)[] = []
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const i = order === 'down' ? c * rows + r : r * cols + c
      cells.push(i < count ? i : null)
    }
  return { cols, rows, cells }
}
