import type { Metadata } from "next";
import { AuditReport } from "../../components/AuditReport";

export const metadata: Metadata = {
  title: "Accessibility report",
  description: "A grouped accessibility report with evidence and practical fix suggestions.",
};

export default async function AuditPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AuditReport auditId={id} />;
}
