import type { Metadata } from "next";
import { BackCover } from "@/components/editorial/BackCover";
import { Masthead } from "@/components/editorial/Masthead";
import { DocNotFound } from "@/components/docs/DocEmptyStates";
import { DocView } from "@/components/docs/DocView";
import { readDoc } from "@/lib/docs";
import { FOOTER, NAV } from "@/lib/nav";

interface PageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const doc = readDoc(slug);
  return { title: doc ? `${doc.ref.title} — Advance` : "Not published — Advance" };
}

export default async function DocSlugPage({ params }: PageProps) {
  const { slug } = await params;
  const doc = readDoc(slug);

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <Masthead links={NAV} current="/docs" />
      <main id="main">{doc ? <DocView fallbackTitle={doc.ref.title} source={doc.source} /> : <DocNotFound slug={slug} />}</main>
      <BackCover
        pitch="Paste any Bankr token. Get a score and a memo."
        action={{ label: "Underwrite an agent", href: "/underwrite", prefetch: false }}
        columns={FOOTER}
        imprint="Advance. Built for Runtime Agent Week on Base."
        page={97}
      />
    </>
  );
}
