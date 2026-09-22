import { Package } from 'lucide-react'
import {
  PageHead, PageBody, Card, Badge, Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { inr, useStoreCatalogue, PRODUCT_CATEGORIES, type CatalogueProduct } from './collections-lib'

/* The store catalogue — the shop window.

   Read-only, and readable by anyone signed in, parents included: it shows what
   the store sells, with a picture, a price and the sizes with a stock badge.
   It takes no finance permission, because it reveals nothing a printed
   catalogue in the foyer would not. Selling, takings and maintenance all stay
   on the staff-only School store screen.

   Laid out as a CSS grid rather than a flexbox row, so it reflows on a phone
   and does not lean on flex `gap`, which the older browsers a few of these
   schools still run do not support. */

const CATEGORY_LABEL: Record<string, string> = Object.fromEntries(
  PRODUCT_CATEGORIES.map((c) => [c.value, c.label]),
)

export default function StoreCatalogue() {
  const catalogue = useStoreCatalogue()

  if (catalogue.isLoading) return <Loading shape="cards" label="Opening the catalogue…" />
  if (catalogue.error) return <ErrorState error={catalogue.error} />

  const items = catalogue.data?.items ?? []

  return (
    <>
      <PageHead
        eyebrow="School store"
        title="Catalogue"
        description="Uniforms, books, stationery and sports kit the school store sells. Prices include GST where it applies."
        width="wide"
      />
      <PageBody width="wide">
        {items.length === 0 ? (
          <EmptyState
            title="The store has nothing on show yet."
            body="Once the office puts items on the price list, they appear here for everyone to browse."
          />
        ) : (
          <div
            className="grid gap-4"
            style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}
          >
            {items.map((p) => (
              <ProductCard key={p.code} product={p} />
            ))}
          </div>
        )}
      </PageBody>
    </>
  )
}

function ProductCard({ product }: { product: CatalogueProduct }) {
  // A product with sizes is "in stock" when any size is; a product with none is
  // judged on nothing here, so it reads as available and the till decides.
  const variants = product.variants ?? []
  const anyStock = variants.length === 0 || variants.some((v) => v.in_stock)

  return (
    <Card className="overflow-hidden">
      <div className="aspect-square w-full bg-muted">
        {product.image_url ? (
          <img
            src={product.image_url}
            alt={product.name}
            className="h-full w-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-muted-foreground">
            <Package className="h-10 w-10" aria-hidden />
          </div>
        )}
      </div>

      <div className="p-4">
        <div className="mb-1.5">
          <Badge tone="neutral" solid>{CATEGORY_LABEL[product.category] ?? product.category}</Badge>
        </div>
        <p className="text-[15px] font-semibold leading-snug">{product.name}</p>
        {product.description && (
          <p className="mt-1 text-[13px] text-muted-foreground">{product.description}</p>
        )}

        <p className="mt-2 text-[15px] font-semibold tabular-nums">{inr(product.price)}</p>

        <div className="mt-2">
          {anyStock ? (
            <Badge tone="success">In stock</Badge>
          ) : (
            <Badge tone="danger">Out of stock</Badge>
          )}
        </div>

        {variants.length > 0 && (
          <div className="scroll-x">
          <table className="mt-3 w-full text-[13px]">
            <tbody>
              {variants.map((v, i) => (
                <tr key={`${v.label}-${i}`} className="align-baseline">
                  <td className="py-0.5 pr-2">{v.label || '—'}</td>
                  <td className="py-0.5 pr-2 text-right tabular-nums">{inr(v.price)}</td>
                  <td className="py-0.5 text-right">
                    {v.in_stock ? (
                      <span className="text-success">{v.stock} left</span>
                    ) : (
                      <span className="text-destructive">Out</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>
    </Card>
  )
}
