-- Plan covers from the Figma design (02b Plan details) replace the generated
-- placeholders for the three listed plans. New object keys rather than overwriting
-- the old ones, so phones that cached the old art fetch the new art at once. The
-- placeholders stay in the bucket for any build still holding the old keys.

update plan_challenges set image_path = 'be-still-v2.png'
 where id = '00000000-0000-0000-0000-0000000000a3';
update plan_challenges set image_path = 'better-together-v2.png'
 where id = '00000000-0000-0000-0000-0000000000a4';
update plan_challenges set image_path = 'abide-v2.png'
 where id = '00000000-0000-0000-0000-0000000000a5';
