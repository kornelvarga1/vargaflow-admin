-- Storage bucket for client onboarding photos.
-- Clients upload photos of their completed work via the public onboarding form,
-- and Kornel downloads them in original quality from the admin UI.
--
-- Bucket is public-read (paths are UUID-based so not guessable), and allows
-- anonymous uploads since the form is public.

INSERT INTO storage.buckets (id, name, public)
VALUES ('onboarding-photos', 'onboarding-photos', true)
ON CONFLICT (id) DO NOTHING;

-- Allow anyone (anon) to upload to this bucket
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
    AND policyname = 'Anyone can upload onboarding photos'
  ) THEN
    CREATE POLICY "Anyone can upload onboarding photos"
      ON storage.objects FOR INSERT
      TO public
      WITH CHECK (bucket_id = 'onboarding-photos');
  END IF;
END $$;

-- Allow anyone to read from this bucket (needed for admin previews + downloads)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
    AND policyname = 'Anyone can read onboarding photos'
  ) THEN
    CREATE POLICY "Anyone can read onboarding photos"
      ON storage.objects FOR SELECT
      TO public
      USING (bucket_id = 'onboarding-photos');
  END IF;
END $$;
