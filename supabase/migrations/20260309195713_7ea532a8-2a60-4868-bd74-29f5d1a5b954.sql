
-- Custom values table (key-value store for settings)
CREATE TABLE public.custom_values (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  value TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'general',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.custom_values ENABLE ROW LEVEL SECURITY;

-- Since this is a single-user tool, allow all operations
CREATE POLICY "Allow all access to custom_values" ON public.custom_values FOR ALL USING (true) WITH CHECK (true);

-- Contacts table
CREATE TABLE public.contacts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  full_name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  lead_source TEXT NOT NULL DEFAULT 'Other',
  pipeline TEXT NOT NULL DEFAULT 'sales',
  stage TEXT NOT NULL DEFAULT 'lead_in',
  tags TEXT[] DEFAULT '{}',
  notes TEXT DEFAULT '',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  last_contacted_at TIMESTAMP WITH TIME ZONE,
  stage_entered_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all access to contacts" ON public.contacts FOR ALL USING (true) WITH CHECK (true);

-- Sequences table (automation templates)
CREATE TABLE public.sequences (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  pipeline TEXT NOT NULL,
  stage TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(pipeline, stage)
);

ALTER TABLE public.sequences ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all access to sequences" ON public.sequences FOR ALL USING (true) WITH CHECK (true);

-- Sequence steps (individual messages in a sequence)
CREATE TABLE public.sequence_steps (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  sequence_id UUID NOT NULL REFERENCES public.sequences(id) ON DELETE CASCADE,
  step_order INTEGER NOT NULL,
  delay_hours INTEGER NOT NULL DEFAULT 0,
  delay_minutes INTEGER NOT NULL DEFAULT 0,
  message_type TEXT NOT NULL DEFAULT 'sms',
  message_template TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(sequence_id, step_order)
);

ALTER TABLE public.sequence_steps ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all access to sequence_steps" ON public.sequence_steps FOR ALL USING (true) WITH CHECK (true);

-- Contact sequences (tracking active automations per contact)
CREATE TABLE public.contact_sequences (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  contact_id UUID NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  sequence_id UUID NOT NULL REFERENCES public.sequences(id) ON DELETE CASCADE,
  current_step INTEGER NOT NULL DEFAULT 0,
  next_fire_at TIMESTAMP WITH TIME ZONE,
  status TEXT NOT NULL DEFAULT 'active',
  started_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.contact_sequences ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all access to contact_sequences" ON public.contact_sequences FOR ALL USING (true) WITH CHECK (true);

-- Activity log
CREATE TABLE public.activity_log (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  contact_id UUID REFERENCES public.contacts(id) ON DELETE CASCADE,
  activity_type TEXT NOT NULL,
  description TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.activity_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all access to activity_log" ON public.activity_log FOR ALL USING (true) WITH CHECK (true);

-- Message queue (scheduled messages to send)
CREATE TABLE public.message_queue (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  contact_id UUID NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  contact_sequence_id UUID REFERENCES public.contact_sequences(id) ON DELETE CASCADE,
  message_type TEXT NOT NULL DEFAULT 'sms',
  message_content TEXT NOT NULL,
  scheduled_at TIMESTAMP WITH TIME ZONE NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  sent_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.message_queue ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all access to message_queue" ON public.message_queue FOR ALL USING (true) WITH CHECK (true);

-- Timestamp update function
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

-- Triggers for updated_at
CREATE TRIGGER update_custom_values_updated_at BEFORE UPDATE ON public.custom_values FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER update_contacts_updated_at BEFORE UPDATE ON public.contacts FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER update_sequences_updated_at BEFORE UPDATE ON public.sequences FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER update_contact_sequences_updated_at BEFORE UPDATE ON public.contact_sequences FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Seed default custom values
INSERT INTO public.custom_values (key, label, value, category, sort_order) VALUES
  ('company_name', 'Company Name', 'Local Scaling', 'general', 1),
  ('my_name', 'My Name', '', 'general', 2),
  ('my_phone', 'My Phone Number', '', 'general', 3),
  ('my_email', 'My Email', '', 'general', 4),
  ('website_url', 'Website URL', '', 'general', 5),
  ('software_explanation_video', 'Software Explanation Video URL', '', 'links', 6),
  ('testimonials_link', 'Testimonials Link', '', 'links', 7),
  ('case_study_link', 'Case Study Link', '', 'links', 8),
  ('demo_calendar_link', 'Demo Calendar Booking Link', '', 'links', 9),
  ('launch_call_calendar_link', 'Launch Call Calendar Booking Link', '', 'links', 10),
  ('instagram_url', 'Instagram URL', '', 'social', 11),
  ('onboarding_form_link', 'Onboarding Form Link', '', 'links', 12);
