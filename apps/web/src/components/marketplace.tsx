"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowDownWideNarrow, ArrowRight, AudioLines, BarChart3, BookOpen, Boxes, Check, Clock3, Code2, FileText, Grid2X2, Heart, Image, List, Search, SlidersHorizontal, Star, X } from "lucide-react";
import type { CapabilityDTO, CatalogPage, PriceTier } from "@/lib/types";
import { useResource, useAction } from "@/lib/hooks";
import { dateTime, duration, money } from "@/lib/format";
import { post } from "@/lib/api";
import { useApp, RequireAuth } from "./provider";
import { Button, Empty, ErrorNotice, IconButton, Loading, PageHeading, Status } from "./ui";
import { CatalogPagination } from "./catalog-pagination";

const visuals = [
  { match: /research/i, icon: BookOpen, className: "research", image: "photo-1486406146926-c627a92ad1ab" },
  { match: /data|analy/i, icon: BarChart3, className: "data", image: "photo-1454165804606-c3d57bc86b40" },
  { match: /writ|doc/i, icon: FileText, className: "documents", image: "photo-1455390582262-044cdead277a" },
  { match: /design|media/i, icon: Image, className: "media", image: "photo-1493225457124-a3eb161ffa5f" },
  { match: /develop/i, icon: Code2, className: "development", image: "photo-1518770660439-4636190af475" },
  { match: /business/i, icon: Boxes, className: "business", image: "photo-1497366754035-f200968a6e72" }
];
export function CategoryVisual({ category, small = false }: { category: string; small?: boolean }) {
  const visual = visuals.find(item => item.match.test(category));
  const Icon = visual?.icon || AudioLines;
  return <div className={`category-visual ${visual?.className || "other"} ${small ? "small" : ""}`} aria-hidden="true">{visual && <img alt="" loading="lazy" src={`https://images.unsplash.com/${visual.image}?auto=format&fit=crop&w=180&q=75`} onError={event => { event.currentTarget.style.display = "none"; }} />}<Icon size={small ? 21 : 25} strokeWidth={1.6} /></div>;
}
export function FavoriteButton({ capability, onChange }: { capability: CapabilityDTO; onChange?: (favorite: boolean) => void }) {
  const { user, authenticate } = useApp();
  const [favorite, setFavorite] = useState(capability.isFavorite || false);
  const action = useAction();
  useEffect(() => setFavorite(capability.isFavorite || false), [capability.isFavorite]);
  return <div className="favorite-control"><IconButton label={favorite ? "Remove from favorites" : "Save to favorites"} aria-pressed={favorite} disabled={action.pending} className={favorite ? "favorited" : ""} onClick={() => { if (!user) return authenticate(); void action.run(async () => { const response = await post<{ isFavorite: boolean }>(`/capabilities/${capability.id}/favorite`); setFavorite(response.isFavorite); onChange?.(response.isFavorite); }); }}><Heart size={18} fill={favorite ? "currentColor" : "none"} /></IconButton>{action.error && <span className="inline-error" role="alert">{action.error}</span>}</div>;
}
export function CapabilityCard({ capability: cap, tiers = [], onFavorite }: { capability: CapabilityDTO; tiers?: PriceTier[]; onFavorite?: (favorite: boolean) => void }) {
  const price = tiers.find(tier => tier.id === cap.priceTierId);
  const input = Array.from(new Set(cap.ioContract.inputs.map(field => ["FILE", "FILES"].includes(field.type) ? "Files" : field.type === "JSON" ? "JSON" : "Text"))).join(" + ") || "No inputs";
  return <article className="capability-card">
    <div className="cap-card-top"><CategoryVisual category={cap.category} /><span className="category-label">{cap.category}</span><FavoriteButton capability={cap} onChange={onFavorite} /></div>
    <Link href={`/capabilities/${cap.slug || cap.id}`} className="capability-title"><h2>{cap.title}</h2><ArrowRight size={17} /></Link>
    <Link href={`/sellers/${cap.seller.id}`} className="seller-name">{cap.seller.name}</Link>
    <p className="capability-summary">{cap.summary}</p>
    <div className="io-line"><span>{input}</span><ArrowRight size={13} /><span>{cap.ioContract.output.files?.allowedExtensions.slice(0,3).join(", ") || cap.ioContract.output.type.toLowerCase()}</span></div>
    <div className="capability-proof"><span><Star size={14} />{cap.rating === null ? "New" : cap.rating.toFixed(1)}{cap.reviewCount > 0 && <small>({cap.reviewCount})</small>}</span><span>{cap.completedJobs.toLocaleString()} jobs</span><span><Clock3 size={13} />{duration(cap.estimatedDurationSeconds)}</span></div>
    <div className="capability-bottom"><div><Status value={cap.availability.status} />{cap.availability.status === "SCHEDULED_OFFLINE" && cap.availability.nextAvailableAt && <small className="availability-time">{dateTime(cap.availability.nextAvailableAt)}</small>}</div><strong>{money(price?.buyerPriceMinor)}<small> / job</small></strong></div>
  </article>;
}
export function Marketplace({ favorites = false }: { favorites?: boolean }) {
  return favorites ? <RequireAuth><MarketplaceContent favorites /></RequireAuth> : <MarketplaceContent />;
}
function MarketplaceContent({ favorites = false }: { favorites?: boolean }) {
  const { config, configError, refreshConfig } = useApp();
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [availability, setAvailability] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [rating, setRating] = useState("");
  const [output, setOutput] = useState("");
  const [runtime, setRuntime] = useState("");
  const [sort, setSort] = useState("RELEVANCE");
  const [filters, setFilters] = useState(false);
  const [view, setView] = useState("grid");
  const [pagination, setPagination] = useState<{ key: string; cursors: string[] }>({ key: "", cursors: [] });
  useEffect(() => { const timeout = setTimeout(() => setSearch(query), 300); return () => clearTimeout(timeout); }, [query]);
  const params = new URLSearchParams();
  if (search) params.set("q", search);
  if (category) params.set("category", category);
  if (availability) params.set("availability", availability);
  if (maxPrice) params.set("maxPrice", maxPrice);
  if (favorites) params.set("favorites", "true");
  if (rating) params.set("minRating", rating);
  if (output) params.set("outputType", output);
  if (runtime) params.set("maxDurationSeconds", runtime);
  params.set("sort", sort); params.set("timezone", Intl.DateTimeFormat().resolvedOptions().timeZone);
  const filterKey = params.toString();
  const cursors = pagination.key === filterKey ? pagination.cursors : [];
  if (cursors.length) params.set("cursor", cursors[cursors.length - 1]);
  const resource = useResource<CatalogPage>(`/capabilities/page?${params}`);
  const capabilities = resource.data?.items || [];
  const filterCount = [availability, maxPrice, rating, output, runtime].filter(Boolean).length;
  function reset() { setQuery(""); setCategory(""); setAvailability(""); setMaxPrice(""); setRating(""); setOutput(""); setRuntime(""); }
  return <>
    <PageHeading eyebrow="The capability marketplace" title={favorites ? "Your favorites" : "Find the right capability."} description={favorites ? "Saved services, current prices and availability." : "Specialized tools and expertise, ready for your next job."} actions={<Link className="button secondary" href="/agent"><MessageIcon />Ask Kivro<ArrowRight size={15} /></Link>} />
    <form className="market-search" role="search" onSubmit={event => { event.preventDefault(); setSearch(query); }}><Search size={21} /><input aria-label="Search capabilities" value={query} onChange={event => setQuery(event.target.value)} placeholder="What do you need to get done?" />{query && <IconButton label="Clear search" onClick={() => { setQuery(""); setSearch(""); }}><X size={17} /></IconButton>}<Button variant="primary" type="submit">Search<ArrowRight size={16} /></Button></form>
    <div className="category-tabs" role="group" aria-label="Category"><button aria-pressed={!category} onClick={() => setCategory("")}><Grid2X2 size={15} />All capabilities</button>{config?.categories.map(name => <button key={name} aria-pressed={category === name} onClick={() => setCategory(name)}>{name}</button>)}</div>
    <ErrorNotice error={configError} retry={refreshConfig} />
    <div className="market-toolbar"><div className="row wrap"><Button onClick={() => setFilters(!filters)} aria-expanded={filters}><SlidersHorizontal size={15} />Filters{filterCount > 0 && <span className="count-badge">{filterCount}</span>}</Button><select aria-label="Availability" className="compact-select" value={availability} onChange={event => setAvailability(event.target.value)}><option value="">Any availability</option><option value="NOW">Available now</option><option value="TODAY">Available today</option><option value="SCHEDULABLE">Schedulable</option><option value="BUSY">Busy</option></select>{filterCount > 0 && <button className="text-button" onClick={reset}>Reset</button>}</div><div className="row"><ArrowDownWideNarrow size={15} /><select className="compact-select" aria-label="Sort capabilities" value={sort} onChange={event => setSort(event.target.value)}><option value="RELEVANCE">Most relevant</option><option value="RATING">Highest rated</option><option value="POPULAR">Most used</option><option value="PRICE_ASC">Price: low to high</option><option value="PRICE_DESC">Price: high to low</option><option value="FASTEST">Fastest</option></select><div className="segmented icon-segmented"><IconButton label="Grid view" aria-pressed={view === "grid"} onClick={() => setView("grid")}><Grid2X2 size={16} /></IconButton><IconButton label="List view" aria-pressed={view === "list"} onClick={() => setView("list")}><List size={17} /></IconButton></div></div></div>
    {filters && <div className="filter-panel"><label className="field">Maximum price<select value={maxPrice} onChange={event => setMaxPrice(event.target.value)}><option value="">Any price</option>{config?.priceTiers.filter(tier => tier.enabled).map(tier => <option key={tier.id} value={tier.buyerPriceMinor}>{money(tier.buyerPriceMinor)}</option>)}</select></label><label className="field">Minimum rating<select value={rating} onChange={event => setRating(event.target.value)}><option value="">Any rating</option><option value="4">4.0 and above</option><option value="4.5">4.5 and above</option><option value="4.8">4.8 and above</option></select></label><label className="field">Output<select value={output} onChange={event => setOutput(event.target.value)}><option value="">Any output</option><option value="TEXT">Text</option><option value="JSON">Structured data</option><option value="FILES">Files</option><option value="MIXED">Text and files</option></select></label><label className="field">Processing time<select value={runtime} onChange={event => setRuntime(event.target.value)}><option value="">Any duration</option><option value="60">Under a minute</option><option value="300">Under 5 minutes</option><option value="900">Under 15 minutes</option><option value="3600">Under an hour</option></select></label></div>}
    <div className="results-caption"><span>{resource.loading ? "Finding capabilities..." : `${resource.data?.total || 0} ${resource.data?.total === 1 ? "capability" : "capabilities"}`}{category && ` in ${category}`}</span><span className="row"><Check size={13} />Fixed price per job</span></div>
    <ErrorNotice error={resource.error} retry={resource.refresh} />
    {resource.loading ? <Loading text="Loading capabilities" rows={6} /> : !resource.error && !capabilities.length ? <Empty icon={favorites ? <Heart size={26} /> : <Search size={26} />} title={favorites ? "No saved capabilities" : "No capabilities found"} description={favorites ? "Save a capability from the marketplace to find it here." : query || category || filterCount ? "Try another search or adjust your filters." : "Published capabilities will appear here when sellers make them available."} href={favorites ? "/" : "/selling/capabilities/new"} action={favorites ? "Explore capabilities" : "Publish a capability"} /> : <div className={`capability-grid ${view === "list" ? "list-view" : ""}`}>{capabilities.map(cap => <CapabilityCard key={cap.id} capability={cap} tiers={config?.priceTiers} onFavorite={favorite => { resource.setData(page => page ? { ...page, items: page.items.map(item => item.id === cap.id ? { ...item, isFavorite: favorite } : item) } : page); if (favorites && !favorite) resource.refresh(); }} />)}</div>}
    {resource.data && !resource.error && <CatalogPagination page={cursors.length} total={resource.data.total} next={resource.data.nextCursor} loading={resource.loading} previous={() => setPagination({ key: filterKey, cursors: cursors.slice(0, -1) })} advance={() => { if (resource.data?.nextCursor) setPagination({ key: filterKey, cursors: [...cursors, resource.data.nextCursor] }); }} />}
  </>;
}
function MessageIcon() { return <AudioLines size={16} />; }
