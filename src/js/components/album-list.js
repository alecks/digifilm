document.addEventListener("alpine:init", () => {
  Alpine.data("albumList", () => {
    return {
      albums: [],
      loading: true,
      error: null,
      workerBaseUrl: "https://api.digifilm.pics",

      async fetchAlbums() {
        try {
          this.loading = true;
          this.error = null;
          const response = await fetch(`${this.workerBaseUrl}/albums`);
          if (!response.ok) {
            throw new Error(
              `HTTP error! status: ${response.status} - ${response.statusText}`,
            );
          }
          this.albums = await response.json();
          console.log(this.albums[0]);
        } catch (e) {
          console.error("Error fetching album list:", e);
          this.error = "Failed to load albums. Please try again later.";
          this.albums = [];
        } finally {
          this.loading = false;
        }
      },
    };
  });
});
