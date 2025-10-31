export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: { ...corsHeaders, "Access-Control-Max-Age": "86400" },
        status: 204,
      });
    }

    const getDimensions = (head, key) => {
      const width = parseInt(head?.customMetadata?.width, 10);
      const height = parseInt(head?.customMetadata?.height, 10);
      if (width > 0 && height > 0) return { width, height };
      console.warn(`No metadata for ${key}, using fallback`);
      return { width: 1200, height: 800 };
    };

    if (url.pathname === "/albums") {
      try {
        const albums = [];
        let cursor;

        do {
          const {
            keys,
            cursor: nextCursor,
            list_complete,
          } = await env.DIGIFILM_GALLERIES.list({ prefix: "album:", cursor });

          for (const { name } of keys) {
            const meta = JSON.parse(await env.DIGIFILM_GALLERIES.get(name));
            const { cover_key, ...albumData } = meta;
            albums.push({
              id: name.replace("album:", ""),
              coverImage: `https://r2.digifilm.pics/cdn-cgi/image/quality=60/${cover_key}`,
              ...albumData,
            });
          }

          cursor = list_complete ? null : nextCursor;
        } while (cursor);

        return Response.json(albums, { headers: corsHeaders });
      } catch (error) {
        console.error("Error fetching albums:", error);
        return Response.json(
          { error: `Failed to fetch albums: ${error.message}` },
          { headers: corsHeaders, status: 500 },
        );
      }
    }

    if (url.pathname.startsWith("/album/")) {
      const albumId = url.pathname.slice(7);
      if (!albumId) {
        return Response.json(
          { error: "Album ID required" },
          { headers: corsHeaders, status: 400 },
        );
      }

      try {
        const metaJson = await env.DIGIFILM_GALLERIES.get(`album:${albumId}`);
        if (!metaJson) {
          return Response.json(
            { error: `Album '${albumId}' not found` },
            { headers: corsHeaders, status: 404 },
          );
        }

        const album = JSON.parse(metaJson);
        const { objects } = await env.DIGIFILM_IMAGES.list({
          prefix: `${albumId}/`,
        });

        const images = await Promise.all(
          objects
            .filter(
              (obj) =>
                obj.size > 0 && /\.(jpe?g|png|gif|webp|avif)$/i.test(obj.key),
            )
            .map(async (obj) => {
              const head = await env.DIGIFILM_IMAGES.head(obj.key).catch(
                () => null,
              );
              const { width, height } = getDimensions(head, obj.key);
              return {
                src: `https://r2.digifilm.pics/${obj.key}`,
                thumbnailSrc: `https://r2.digifilm.pics/cdn-cgi/image/quality=60/${obj.key}`,
                width,
                height,
              };
            }),
        );

        return Response.json(
          { album: { id: albumId, ...album }, images },
          { headers: corsHeaders },
        );
      } catch (error) {
        console.error(`Error fetching album ${albumId}:`, error);
        return Response.json(
          { error: `Failed to fetch album: ${error.message}` },
          { headers: corsHeaders, status: 500 },
        );
      }
    }

    return new Response("Not Found", { headers: corsHeaders, status: 404 });
  },
};
