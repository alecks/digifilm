import EleventyVitePlugin from "@11ty/eleventy-plugin-vite";
import tailwindcss from "@tailwindcss/vite";

export default function(eleventyConfig) {
  eleventyConfig.addPassthroughCopy('src');
  eleventyConfig.addPlugin(EleventyVitePlugin, {
    viteOptions: {
      plugins: [tailwindcss()]
    }
  });

  eleventyConfig.addCollection("menuItems", function(collectionApi) {
    return collectionApi.getAll().filter(item => item.data.navitem)
      .sort((a, b) => (a.data.navorder || 99) - (b.data.navorder || 99));
  });

  return {
    templateFormats: ["njk", "md"],
    htmlTemplateEngine: "njk",
    markdownTemplateEngine: "njk",
  };
}
