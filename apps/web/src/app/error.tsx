"use client";
import { Button, Notice, PageHeading } from "@/components/ui";
export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return <><PageHeading title="This page could not load" /><Notice tone="danger">Please try again. Your submitted jobs remain in your job history.</Notice><Button onClick={reset}>Try again</Button></>;
}
