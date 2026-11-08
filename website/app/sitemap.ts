import type { MetadataRoute } from "next";
export default function sitemap(): MetadataRoute.Sitemap {
  return [{
    url: process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000",
    lastModified: new Date("2026-11-07T00:00:00Z"),
    changeFrequency: "monthly",
    priority: 1,
  }, {
    url: (process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000").replace(/\/$/, "") + "/career",
    lastModified: new Date("2026-11-08T00:00:00Z"),
    changeFrequency: "monthly",
    priority: 0.7,
  }];
}
