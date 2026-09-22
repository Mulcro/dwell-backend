-- Deleting an account must not be blocked by having created a group, and must not
-- destroy a group that other people are still using.
--
-- The design doc has created_by as a plain NOT NULL reference, which makes the creator
-- undeletable: their auth.users row cascades to public.users, and this FK then refuses.
-- Decision: the group outlives its creator, losing only the attribution.

alter table groups alter column created_by drop not null;

alter table groups drop constraint groups_created_by_fkey;

alter table groups add constraint groups_created_by_fkey
  foreign key (created_by) references users(id) on delete set null;
