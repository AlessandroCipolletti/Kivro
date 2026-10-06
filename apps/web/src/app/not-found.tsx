import Link from "next/link";
export default function NotFound() { return <div className="empty-state"><h1>Page not found</h1><p>This address is no longer available.</p><Link href="/" className="button primary">Browse marketplace</Link></div>; }
