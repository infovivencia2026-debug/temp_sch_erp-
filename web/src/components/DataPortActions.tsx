import { type ReactNode } from 'react'
import { Upload } from 'lucide-react'
import BulkImport from '@/components/BulkImport'
import { Button, Dialog, ExportButton as ReportExportButton } from '@/components/ui'
import { useOpenState } from '@/lib/motion'

/* Two header actions for every screen whose data the backend can already read
 * in and hand back out.
 *
 * The machinery for both already exists — BulkImport carries the whole
 * upload / dry-run / commit flow, and /api/v1/export/{name} streams a CSV — but
 * a clerk had to leave the screen and find a central page to use either. These
 * put the same two actions where the data is: an Import button that opens the
 * existing bulk importer in a dialog, and an Export button that downloads the
 * dataset. Both wear the product's ordinary secondary-action styling, so a
 * header does not sprout a control that looks like it came from elsewhere.
 */

/**
 * Download a dataset the server exposes at /api/v1/export/{name}.
 *
 * A thin wrapper over the shared export button, which is a plain <a href download>
 * rather than a fetch-and-blob or the File System Access API: the browser
 * follows the link, carries the session cookie, and streams the file to disk
 * without buffering it — which works on the oldest browser a school owns. This
 * exists only so a screen can name the *dataset* ("students") rather than the
 * export slug, matching the ImportButton beside it.
 */
export function ExportButton({
  name,
  label,
}: {
  /** A dataset name from the server's `exportable` map: students, marks, … */
  name: string
  label?: string
}) {
  return <ReportExportButton report={name} label={label ?? 'Export'} />
}

/**
 * Open the existing bulk importer for one entity, in a dialog over the page.
 *
 * The button sits in the header; the importer — template, drag-and-drop, the
 * dry run and the history — opens in a modal so the screen underneath keeps its
 * place. Nothing about the import flow is reimplemented here; this is only the
 * door to it.
 */
export function ImportButton({
  entity,
  label = 'Import',
  title,
  hint,
  subjectMapping,
  params,
  endpoint,
  templateUrl,
}: {
  /** An entity the server imports (see importSpecs in bulk_import.go). */
  entity: string
  label?: string
  /** The dialog heading — defaults to a title made from the entity name. */
  title?: string
  hint?: string
  subjectMapping?: boolean
  params?: Record<string, string>
  /** Overrides for an entity with an importer of its own (students). */
  endpoint?: string
  templateUrl?: string
}) {
  const [open, setOpen] = useOpenState(false)
  const nice = entity.replace(/_/g, ' ')
  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => setOpen(true)}
        title={title ?? `Import ${nice} from a spreadsheet`}
      >
        <Upload className="h-3.5 w-3.5" />
        {label}
      </Button>
      {open && (
        <ImportDialog onClose={() => setOpen(false)}>
          <BulkImport
            entity={entity}
            title={title ?? `Import ${nice}`}
            hint={
              hint ??
              'Drop a CSV, or paste the cells. Nothing is written until the ' +
                'check has passed, the first upload is always a dry run.'
            }
            subjectMapping={subjectMapping}
            params={params}
            endpoint={endpoint}
            templateUrl={templateUrl}
          />
        </ImportDialog>
      )}
    </>
  )
}

/* The frame around the importer.
 *
 * Portalled to the body for the reason SheetViewer is: a .card ancestor carries
 * a transform while pressed, which would otherwise become the containing block
 * for anything fixed inside it and pin the dialog inside the card instead of
 * over the page. Escape and the backdrop both close it, and the phone's Back
 * button does too, through the overlay-history hook. */
function ImportDialog({
  children,
  onClose,
}: {
  children: ReactNode
  onClose: () => void
}) {
  /* The shared Dialog: portalled clear of any pressed (transformed) card,
     Escape, the dim and the phone's Back all close it, focus is trapped. */
  return (
    <Dialog
      onClose={onClose}
      size="lg"
      label="Import"
      footer={<Button variant="secondary" onClick={onClose}>Close</Button>}
    >
      {children}
    </Dialog>
  )
}
