export default function Page() {
  return (
    <main className="min-h-full bg-white px-8 py-10 font-sans text-neutral-900">
      <header className="mb-8 flex items-end justify-between gap-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Stays worth the flight</h1>
          <p className="mt-1 text-sm text-neutral-500">Hand-picked homes, open for spring</p>
        </div>
        <a className="text-sm font-semibold underline underline-offset-4" href="#">Show all</a>
      </header>

      <div className="grid grid-cols-1 gap-x-6 gap-y-10 sm:grid-cols-2 xl:grid-cols-4">
        <article className="group">
          <div className="relative aspect-square overflow-hidden rounded-2xl bg-neutral-100">
            <img
              className="h-full w-full object-cover"
              src="https://images.unsplash.com/photo-1493976040374-85c8e12f0c0e?w=900&h=900&fit=crop&q=80"
              alt="A lantern-lit lane below the Yasaka pagoda in Kyoto"
            />
            <span className="absolute left-3 top-3 rounded-full bg-white px-3 py-1 text-xs font-semibold shadow-sm">Guest favorite</span>
            <button className="absolute right-3 top-3 text-white" aria-label="Save to wishlist">
              <svg className="h-6 w-6" viewBox="0 0 24 24" fill="rgba(0,0,0,0.4)" stroke="currentColor" strokeWidth="2">
                <path d="M12 20.5s-7.5-4.6-9.3-9.2C1.4 8 3.3 4.5 6.8 4.5c2.1 0 3.9 1.3 5.2 3 1.3-1.7 3.1-3 5.2-3 3.5 0 5.4 3.5 4.1 6.8-1.8 4.6-9.3 9.2-9.3 9.2z" />
              </svg>
            </button>
          </div>
          <div className="mt-3 flex items-start justify-between gap-2">
            <h2 className="font-semibold">Kyoto, Japan</h2>
            <span className="text-sm">★ 4.97</span>
          </div>
          <p className="text-sm text-neutral-500">Machiya townhouse in Higashiyama</p>
          <p className="text-sm text-neutral-500">Apr 3 – 8</p>
          <p className="mt-1.5 text-sm"><span className="font-semibold underline">$1,240</span> total</p>
        </article>

        <article className="group">
          <div className="relative aspect-square overflow-hidden rounded-2xl bg-neutral-100">
            <img
              className="h-full w-full object-cover"
              src="https://images.unsplash.com/photo-1570077188670-e3a8d69ac5ff?w=900&h=900&fit=crop&q=80"
              alt="White houses stacked above the caldera in Oia, Santorini"
            />
            <span className="absolute left-3 top-3 rounded-full bg-white px-3 py-1 text-xs font-semibold shadow-sm">Rare find</span>
            <button className="absolute right-3 top-3 text-white" aria-label="Save to wishlist">
              <svg className="h-6 w-6" viewBox="0 0 24 24" fill="rgba(0,0,0,0.4)" stroke="currentColor" strokeWidth="2">
                <path d="M12 20.5s-7.5-4.6-9.3-9.2C1.4 8 3.3 4.5 6.8 4.5c2.1 0 3.9 1.3 5.2 3 1.3-1.7 3.1-3 5.2-3 3.5 0 5.4 3.5 4.1 6.8-1.8 4.6-9.3 9.2-9.3 9.2z" />
              </svg>
            </button>
          </div>
          <div className="mt-3 flex items-start justify-between gap-2">
            <h2 className="font-semibold">Oia, Greece</h2>
            <span className="text-sm">★ 4.92</span>
          </div>
          <p className="text-sm text-neutral-500">Cave house above the caldera</p>
          <p className="text-sm text-neutral-500">May 12 – 17</p>
          <p className="mt-1.5 text-sm"><span className="font-semibold underline">$2,180</span> total</p>
        </article>

        <article className="group">
          <div className="relative aspect-square overflow-hidden rounded-2xl bg-neutral-100">
            <img
              className="h-full w-full object-cover"
              src="https://images.unsplash.com/photo-1476514525535-07fb3b4ae5f1?w=900&h=900&fit=crop&q=80"
              alt="A wooden rowing boat on the green water of Lago di Braies"
            />
            <button className="absolute right-3 top-3 text-white" aria-label="Save to wishlist">
              <svg className="h-6 w-6" viewBox="0 0 24 24" fill="rgba(0,0,0,0.4)" stroke="currentColor" strokeWidth="2">
                <path d="M12 20.5s-7.5-4.6-9.3-9.2C1.4 8 3.3 4.5 6.8 4.5c2.1 0 3.9 1.3 5.2 3 1.3-1.7 3.1-3 5.2-3 3.5 0 5.4 3.5 4.1 6.8-1.8 4.6-9.3 9.2-9.3 9.2z" />
              </svg>
            </button>
          </div>
          <div className="mt-3 flex items-start justify-between gap-2">
            <h2 className="font-semibold">Lago di Braies, Italy</h2>
            <span className="text-sm">★ 4.89</span>
          </div>
          <p className="text-sm text-neutral-500">Alpine lodge on the water</p>
          <p className="text-sm text-neutral-500">Jun 20 – 25</p>
          <p className="mt-1.5 text-sm"><span className="font-semibold underline">$1,615</span> total</p>
        </article>

        <article className="group">
          <div className="relative aspect-square overflow-hidden rounded-2xl bg-neutral-100">
            <img
              className="h-full w-full object-cover"
              src="https://images.unsplash.com/photo-1537996194471-e657df975ab4?w=900&h=900&fit=crop&q=80"
              alt="The Ulun Danu Beratan temple reflected in a misty lake in Bali"
            />
            <span className="absolute left-3 top-3 rounded-full bg-white px-3 py-1 text-xs font-semibold shadow-sm">New</span>
            <button className="absolute right-3 top-3 text-white" aria-label="Save to wishlist">
              <svg className="h-6 w-6" viewBox="0 0 24 24" fill="rgba(0,0,0,0.4)" stroke="currentColor" strokeWidth="2">
                <path d="M12 20.5s-7.5-4.6-9.3-9.2C1.4 8 3.3 4.5 6.8 4.5c2.1 0 3.9 1.3 5.2 3 1.3-1.7 3.1-3 5.2-3 3.5 0 5.4 3.5 4.1 6.8-1.8 4.6-9.3 9.2-9.3 9.2z" />
              </svg>
            </button>
          </div>
          <div className="mt-3 flex items-start justify-between gap-2">
            <h2 className="font-semibold">Bedugul, Bali</h2>
            <span className="text-sm">★ 4.94</span>
          </div>
          <p className="text-sm text-neutral-500">Lakeside villa in the highlands</p>
          <p className="text-sm text-neutral-500">Jul 8 – 13</p>
          <p className="mt-1.5 text-sm"><span className="font-semibold underline">$960</span> total</p>
        </article>
      </div>
    </main>
  );
}
