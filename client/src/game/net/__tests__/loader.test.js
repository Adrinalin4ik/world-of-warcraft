import Loader from '../loader';

// A GitHub Actions repository variable saved with a trailing line break reached the bundle as
// `https://host/12340\r\n`, and `encodeURI` put those two characters into every asset URL as
// `%0D%0A` -- so every request 404'd, on a deployment where the asset host itself was fine.
it('keeps a stray newline or trailing slash in the configured host out of asset URLs', () => {
  const loader = new Loader();
  loader.prefix = 'https://host.example/12340/\r\n';

  expect(loader.url('Textures\\SunGlare.blp')).toBe(
    'https://host.example/12340/textures/sunglare.blp'
  );
});
