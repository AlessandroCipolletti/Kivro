import { SellerProfile } from "@/components/capability-detail";
export default async function Page({ params }: { params: Promise<{ id: string }> }) { const { id } = await params; return <SellerProfile id={id} />; }
