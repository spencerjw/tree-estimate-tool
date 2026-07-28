#!/usr/bin/env python3
"""TreeSnap image generator - local SDXL photo + crisp overlay. Run on a CUDA GPU.
  python bots/fb_poster/imagegen/generate_cards.py            # generate any missing images
  python bots/fb_poster/imagegen/generate_cards.py --force    # regenerate all
  python bots/fb_poster/imagegen/generate_cards.py 233 244    # regenerate specific post ids
No people (AI hands/poses are unreliable); scene photo is AI, text is composited crisp on top."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sdxl_gen, overlay

ASSETS = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "assets"))
SUFFIX = (", no people, empty, professional advertising photograph, commercial photography, "
          "sharp focus, high detail, 35mm, photorealistic, natural light")
SCENE_PROMPTS = {
 "bucket_truck": "a white tree service bucket truck with an aerial lift bucket and a folded boom arm, parked on a residential street in front of large green trees, {light}, realistic proportions",
 "canopy":       "a massive majestic mature oak tree with a huge wide spreading canopy in a suburban front yard, {light}",
 "logs":         "a neat stack of freshly cut tree log rounds and a pile of wood chips on a green lawn beside a large tree, {light}",
 "stump":        "a large freshly cut tree stump with scattered wood chips on a manicured suburban lawn, {light}",
 "storm":        "a large tree with a heavy broken branch fallen on a green suburban lawn after a storm, snapped bare wood, dark dramatic overcast stormy sky",
 "dead_tree":    "a large dead leafless tree with bare gray weathered branches standing in a suburban front yard, clearly dead and needing removal, {light}",
}
# frames flagged for redo get fresh seeds so re-running produces a different image
SEED_OVERRIDE = {224:7224, 228:7228, 234:11234, 238:7238, 243:13243, 244:11244,
                 245:7245, 246:13246, 249:11249, 250:7250, 254:13254, 259:7259, 260:11260}
# storm-scene trees rendered unrealistically -> all seven are now dead trees (realistic anatomy)
# under varied skies incl. dramatic overcast, for the "needs removal" look without weird trunks.
SCENE_OVERRIDE = {234:("dead_tree","dusk"), 243:("dead_tree","storm"), 244:("dead_tree","clear"),
                  246:("dead_tree","storm"), 249:("dead_tree","golden"), 254:("dead_tree","clear"),
                  260:("dead_tree","dusk")}
LIGHT = {"golden":"golden hour warm sunlight","clear":"bright midday sun and clear blue sky",
         "dusk":"soft warm dusk light","storm":"dramatic dark overcast stormy sky"}

# (id, headline_lines, badge, scene, sky, [estimate_label, total], image_name, seed)
CARDS = [
  (224, ['Book fall', 'work now.'], 'FALL BOOKING', 'storm', 'storm', ['Oak removal + stump', '$2,200'], 'treesnap_224_fall_booking.png', 1000),
  (225, ['A number', 'in 2 minutes.'], 'SPEED WINS', 'canopy', 'clear', ['Crown reduction, 3 trees', '$1,450'], 'treesnap_225_speed_wins.png', 1001),
  (226, ['Stop driving', 'to dead ends.'], 'NO PRE-BID VISITS', 'logs', 'dusk', ['Deadwood + haul-away', '$980'], 'treesnap_226_no_pre_bid_visits.png', 1002),
  (227, ['Snap.', 'Estimate.', 'Close.'], 'HOW IT WORKS', 'stump', 'golden', ['Stump grinding x4', '$600'], 'treesnap_227_how_it_works.png', 1003),
  (228, ['Same leads.', 'More jobs.'], 'THE MATH', 'storm', 'storm', ['Emergency limb removal', '$1,800'], 'treesnap_228_the_math.png', 1004),
  (229, ['Leads while', 'you sleep.'], '24/7 CAPTURE', 'bucket_truck', 'dusk', ['Large pine removal', '$2,650'], 'treesnap_229_24_7_capture.png', 1005),
  (230, ['Your brand.', 'Not ours.'], 'WHITE LABEL', 'canopy', 'golden', ['Canopy thinning', '$1,150'], 'treesnap_230_white_label.png', 1006),
  (231, ['11 jobs.', 'Zero drives.'], 'REAL RESULTS', 'logs', 'clear', ['Storm cleanup + haul', '$2,100'], 'treesnap_231_real_results.png', 1007),
  (232, ['Built for', 'residential.'], 'RESIDENTIAL TREE', 'stump', 'dusk', ['Hazard limb + cabling', '$1,300'], 'treesnap_232_residential_tree.png', 1008),
  (233, ['Dead tree?', 'Book it fast.'], 'SUMMER STRESS', 'storm', 'storm', ['Lot clearing, 6 trees', '$3,400'], 'treesnap_233_summer_stress.png', 1009),
  (234, ['Win the', 'phone tag.'], 'BEAT THE COMPETITION', 'bucket_truck', 'clear', ['Oak removal + stump', '$2,200'], 'treesnap_234_beat_the_competition.png', 1010),
  (235, ['What the', 'AI sees.'], 'AI ESTIMATES', 'canopy', 'dusk', ['Crown reduction, 3 trees', '$1,450'], 'treesnap_235_ai_estimates.png', 1011),
  (236, ['Try it.', 'Zero risk.'], 'FREE TRIAL', 'logs', 'golden', ['Deadwood + haul-away', '$980'], 'treesnap_236_free_trial.png', 1012),
  (237, ['Fall cleanup', 'starts now.'], 'FALL SEASON', 'stump', 'clear', ['Stump grinding x4', '$600'], 'treesnap_237_fall_season.png', 1013),
  (238, ['First number', 'wins.'], 'SPEED WINS', 'storm', 'storm', ['Emergency limb removal', '$1,800'], 'treesnap_238_speed_wins.png', 1014),
  (239, ['Half your', 'week on bids?'], 'TIME IS MONEY', 'bucket_truck', 'golden', ['Large pine removal', '$2,650'], 'treesnap_239_time_is_money.png', 1015),
  (240, ['Missed lead.', 'Missed job.'], "DON'T MISS LEADS", 'canopy', 'clear', ['Canopy thinning', '$1,150'], 'treesnap_240_don_t_miss_leads.png', 1016),
  (241, ['Win commercial', 'accounts.'], 'COMMERCIAL TREE', 'logs', 'dusk', ['Storm cleanup + haul', '$2,100'], 'treesnap_241_commercial_tree.png', 1017),
  (242, ['Itemized.', 'Professional.'], 'LOOK THE PART', 'stump', 'golden', ['Hazard limb + cabling', '$1,300'], 'treesnap_242_look_the_part.png', 1018),
  (243, ['Your brand on', 'every estimate.'], 'WHITE LABEL', 'storm', 'storm', ['Lot clearing, 6 trees', '$3,400'], 'treesnap_243_white_label.png', 1019),
  (244, ['3 leads', 'became 11.'], 'REAL RESULTS', 'bucket_truck', 'dusk', ['Oak removal + stump', '$2,200'], 'treesnap_244_real_results.png', 1020),
  (245, ['$600 or', '$2,200?'], 'EDUCATE TO WIN', 'canopy', 'golden', ['Crown reduction, 3 trees', '$1,450'], 'treesnap_245_educate_to_win.png', 1021),
  (246, ['Book your', 'busiest season.'], 'PEAK SEASON', 'storm', 'storm', ['Deadwood + haul-away', '$980'], 'treesnap_246_peak_season.png', 1022),
  (247, ['Answer', 'the same day.'], 'SAME-DAY RESPONSE', 'stump', 'dusk', ['Stump grinding x4', '$600'], 'treesnap_247_same_day_response.png', 1023),
  (248, ['Trim. Grind.', 'Remove.'], 'EVERY JOB TYPE', 'storm', 'storm', ['Emergency limb removal', '$1,800'], 'treesnap_248_every_job_type.png', 1024),
  (249, ['7pm lead.', '7:02 reply.'], 'BEAT THE COMPETITION', 'bucket_truck', 'clear', ['Large pine removal', '$2,650'], 'treesnap_249_beat_the_competition.png', 1025),
  (250, ['Leaves fall.', 'Dead limbs', 'show.'], 'Q4 DEMAND', 'storm', 'storm', ['Canopy thinning', '$1,150'], 'treesnap_250_q4_demand.png', 1026),
  (251, ['$79 vs.', 'lost jobs.'], 'THE MATH', 'logs', 'golden', ['Storm cleanup + haul', '$2,100'], 'treesnap_251_the_math.png', 1027),
  (252, ['Respond', 'first.'], 'SPEED WINS', 'stump', 'clear', ['Hazard limb + cabling', '$1,300'], 'treesnap_252_speed_wins.png', 1028),
  (253, ['No card.', 'No risk.'], 'FREE TRIAL', 'storm', 'storm', ['Lot clearing, 6 trees', '$3,400'], 'treesnap_253_free_trial.png', 1029),
  (254, ['Estimates', 'off your plate.'], 'FIX THE PROCESS', 'bucket_truck', 'golden', ['Oak removal + stump', '$2,200'], 'treesnap_254_fix_the_process.png', 1030),
  (255, ['HOA cleanup', 'season.'], 'PROPERTY CLEANUP', 'canopy', 'clear', ['Crown reduction, 3 trees', '$1,450'], 'treesnap_255_property_cleanup.png', 1031),
  (256, ['From photo', 'to price.'], 'AI ESTIMATES', 'logs', 'dusk', ['Deadwood + haul-away', '$980'], 'treesnap_256_ai_estimates.png', 1032),
  (257, ['"Best move', 'we made."'], 'REAL RESULTS', 'stump', 'golden', ['Stump grinding x4', '$600'], 'treesnap_257_real_results.png', 1033),
  (258, ["Winter's", 'coming. Book', 'now.'], 'PRE-WINTER', 'storm', 'storm', ['Emergency limb removal', '$1,800'], 'treesnap_258_pre_winter.png', 1034),
  (259, ['Look like the', 'pros you are.'], 'WHITE LABEL', 'bucket_truck', 'dusk', ['Large pine removal', '$2,650'], 'treesnap_259_white_label.png', 1035),
  (260, ['45% vs.', '12%.'], 'THE MATH', 'canopy', 'golden', ['Canopy thinning', '$1,150'], 'treesnap_260_the_math.png', 1036),
  (261, ['Finish the', 'year booked.'], 'PRE-WINTER', 'logs', 'clear', ['Storm cleanup + haul', '$2,100'], 'treesnap_261_pre_winter.png', 1037),
  (262, ['Set up', 'before winter.'], 'FREE TRIAL', 'stump', 'dusk', ['Hazard limb + cabling', '$1,300'], 'treesnap_262_free_trial.png', 1038),
]

def main():
    force = "--force" in sys.argv
    ids = {int(a) for a in sys.argv[1:] if a.isdigit()}
    for pid, head, badge, scene, sky, est, img, seed in CARDS:
        if ids and pid not in ids: continue
        out = os.path.join(ASSETS, img)
        if os.path.exists(out) and not force and not ids:
            continue
        scene, sky = SCENE_OVERRIDE.get(pid, (scene, sky))
        prompt = SCENE_PROMPTS[scene].format(light=LIGHT[sky]) + SUFFIX
        seed = SEED_OVERRIDE.get(pid, seed)
        print(f"#{pid} {scene}/{sky} seed={seed} -> {img}", flush=True)
        scene_img = sdxl_gen.gen(prompt, seed=seed)
        overlay.compose(scene_img, list(head), badge, ("TreeSnap",".cloud"), out,
                        badge_fill=overlay.ORANGE, chip=tuple(est))
    print("done")

if __name__ == "__main__":
    main()
