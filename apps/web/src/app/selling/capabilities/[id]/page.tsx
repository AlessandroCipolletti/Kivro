import { CapabilityEditor } from "@/components/capability-editor";
export default async function Page({ params }: { params: Promise<{ id: string }> }) { const { id } = await params; return <CapabilityEditor id={id} />; }
