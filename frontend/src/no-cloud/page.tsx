import type { Metadata } from "next";
import { notFound } from "next/navigation";

// Stands in for Emplio Cloud's pages (cloud/frontend/app) in a copy without the private cloud/ folder: not found.
export const metadata: Metadata = {};
// for the pages with many addresses (app/site/[...slug]): one address to build, and it is not found either
export const generateMetadata = async (): Promise<Metadata> => ({});
export const generateStaticParams = () => [{ slug: ["none"] }];
export default function NoCloud(): React.ReactNode {
  notFound();
}
