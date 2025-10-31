import PhotoSwipeLightbox from "photoswipe/lightbox";
import PhotoSwipe from "photoswipe";
import Masonry from "masonry-layout";
import imagesLoaded from "imagesloaded";
import JSZip from "jszip";

document.addEventListener("alpine:init", () => {
  Alpine.data("singleAlbum", function () {
    return {
      data: null,
      loading: true,
      error: null,
      workerBaseUrl: "https://api.digifilm.pics",
      currentAlbumId: null,
      photoSwipeLightbox: null,
      masonryInstance: null,
      downloading: false,
      downloadProgress: 0,

      async downloadZip() {
        if (this.downloading || !this.data?.images?.length) return;

        this.downloading = true;
        this.downloadProgress = 0;

        try {
          const zip = new JSZip();
          const folder = zip.folder(
            this.data.album.title || this.currentAlbumId,
          );

          for (let i = 0; i < this.data.images.length; i++) {
            const image = this.data.images[i];
            const response = await fetch(image.src);
            const blob = await response.blob();

            const filename = `image-${i + 1}.jpg`;
            folder.file(filename, blob);

            this.downloadProgress = Math.round(
              ((i + 1) / this.data.images.length) * 100,
            );
          }

          const content = await zip.generateAsync({ type: "blob" });

          const url = URL.createObjectURL(content);
          const a = document.createElement("a");
          a.href = url;
          a.download = `${this.data.album.title || this.currentAlbumId}.zip`;
          a.click();
          URL.revokeObjectURL(url);

          this.downloadProgress = 100;
        } catch (e) {
          alert("Failed to create ZIP. Please try again.");
          console.error(e);
        } finally {
          this.downloading = false;
          setTimeout(() => (this.downloadProgress = 0), 2000);
        }
      },

      getAlbumIdFromHash() {
        const hash = window.location.hash;
        return hash?.length > 1 ? hash.substring(1) : null;
      },

      setDefaultAlbumState() {
        this.error = "No album specified in URL hash.";
        this.data = {
          album: {
            title: "No Album Selected",
            description: "Please navigate from the album list.",
          },
          images: [],
        };
        this.loading = false;
        this._destroyInstances();
      },

      async fetchAlbumData(albumId) {
        if (!albumId) {
          this.setDefaultAlbumState();
          return;
        }

        this.loading = true;
        this.error = null;
        this.currentAlbumId = albumId;
        this.data = {
          album: { title: "Loading...", description: "Loading details..." },
          images: [],
        };
        this._destroyInstances();

        try {
          const response = await fetch(
            `${this.workerBaseUrl}/album/${albumId}`,
          );
          if (!response.ok) throw new Error(`HTTP ${response.status}`);

          this.data = await response.json();

          this.$nextTick(() => {
            if (this.data.images.length > 0) this._initInstances();
            else this._destroyInstances();
          });
        } catch (e) {
          this.error =
            "Please check that the album still exists. Email if this persists.";
          this.data = {
            album: {
              title: "Error Loading Album",
              description: "Could not load album details.",
            },
            images: [],
          };
          this._destroyInstances();
        } finally {
          this.loading = false;
        }
      },

      _destroyInstances() {
        this.masonryInstance?.destroy();
        this.masonryInstance = null;
        this.photoSwipeLightbox?.destroy();
        this.photoSwipeLightbox = null;
      },

      _initInstances() {
        const grid = document.getElementById("album");
        if (!grid) return;

        this.masonryInstance = new Masonry(grid, {
          itemSelector: ".album-item",
          columnWidth: ".grid-sizer",
          gutter: 16,
          percentPosition: false,
          transitionDuration: "0.4s",
        });

        imagesLoaded(grid).on("progress", () => this.masonryInstance.layout());

        this.photoSwipeLightbox = new PhotoSwipeLightbox({
          gallery: "#album",
          children: "a.album-item",
          pswpModule: PhotoSwipe,
        });
        this.photoSwipeLightbox.init();
      },

      init() {
        this.fetchAlbumData(this.getAlbumIdFromHash());

        window.addEventListener("hashchange", () => {
          const newAlbumId = this.getAlbumIdFromHash();
          if (newAlbumId && newAlbumId !== this.currentAlbumId) {
            this.fetchAlbumData(newAlbumId);
          } else if (!newAlbumId) {
            this.setDefaultAlbumState();
          }
        });
      },
    };
  });
});
