"use client";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "./ui";

export function CatalogPagination({ page, total, next, loading, previous, advance }: { page: number; total: number; next: string | null; loading: boolean; previous: () => void; advance: () => void }) {
  return <nav className="catalog-pagination row between wrap" aria-label="Catalog pages"><span className="muted small">Page {page + 1} / {total} capabilities</span><div className="row"><Button onClick={previous} disabled={loading || page === 0}><ChevronLeft size={16} />Previous</Button><Button onClick={advance} disabled={loading || !next}>Next<ChevronRight size={16} /></Button></div></nav>;
}
