/* ============================================================
   资产清单 / 批量加载 / 世界实例化批处理
   ============================================================ */
import * as THREE from 'three';
import { loadAsset, TexCache, clipGeometryY, deriveWindowMask } from './obj.js';
import { reattachProcShader, windowMaskFor } from './proc.js';
import { yieldFrame } from './util.js';

/* ---------------------------------------------------------- 资产清单 */
// preset: building | prop | vehicle | weapon | character | ground | backdrop
// pivot : base(默认) | origin | center
// mode  : inst(默认，合并实例化) | solo(独立网格，可独立视锥剔除)
// mat   : 材质微调（嵌套一层，不填就用 preset 的默认值）
//         { roughness, metalness, env, coat, coatRough, normalScale, albedo }
const A = (f, o = {}) => ({ f, ...o });

export const GROUPS = {
  core: {
    label: '载入武器与手臂',
    items: [
      A('gameplay_weapons_scar-h_scar_h_static_mesh', { preset: 'weapon', maxSize: 1024, normal: true, pivot: 'center', mode: 'solo' }),
      A('gameplay_weapons_ump45_ump_mesh3p_animationprop_mesh', { preset: 'weapon', maxSize: 1024, normal: true, pivot: 'center', mode: 'solo' }),
    ],
  },
  people: {
    label: '载入人物',
    items: [
      A('characters_mp_ch_assault_ch_assault_upperbody_mesh', { preset: 'character', maxSize: 1024, normal: true, pivot: 'origin', mode: 'solo' }),
      A('characters_mp_ch_assault_ch_assault_lowerbody_mesh', { preset: 'character', maxSize: 512, pivot: 'origin', mode: 'solo' }),
      A('characters_mp_ch_recon_ch_recon_upperbody_mesh', { preset: 'character', maxSize: 1024, normal: true, pivot: 'origin', mode: 'solo' }),
      A('characters_mp_ch_recon_ch_recon_lowerbody_mesh', { preset: 'character', maxSize: 512, pivot: 'origin', mode: 'solo' }),
      A('characters_mp_ch_support_ch_support_upperbody_mesh', { preset: 'character', maxSize: 1024, normal: true, pivot: 'origin', mode: 'solo' }),
      A('characters_mp_ch_support_ch_support_lowerbody_mesh', { preset: 'character', maxSize: 512, pivot: 'origin', mode: 'solo' }),
      A('characters_mp_ch_engineer_ch_engineer_headgear_mesh', { preset: 'character', maxSize: 512, pivot: 'origin', mode: 'solo' }),
      A('characters_mp_ru_support_ru_support_headgear02_mesh', { preset: 'character', maxSize: 512, pivot: 'origin', mode: 'solo' }),
      A('characters_sp_enemy_prisonguard_sp_prisonguard_fullbody_mesh', { preset: 'character', maxSize: 1024, normal: true, pivot: 'origin', mode: 'solo' }),
      A('characters_sp_enemy_prisonguard_sp_prisonguard_cap_mesh', { preset: 'character', maxSize: 512, pivot: 'origin', mode: 'solo' }),
      A('characters_sp_enemy_riotpolice_sp_riot_police_mesh', { preset: 'character', maxSize: 1024, normal: true, pivot: 'origin', mode: 'solo' }),
      A('characters_sp_civilian_fullbody_warsaw_civilian_01_civilian_body_01_mesh', { preset: 'character', maxSize: 1024, normal: true, pivot: 'origin', mode: 'solo' }),
      A('characters_sp_civilian_fullbody_warsaw_civilian_02_civilian_body_02_mesh', { preset: 'character', maxSize: 1024, normal: true, pivot: 'origin', mode: 'solo' }),
      A('characters_sp_civilian_fullbody_warsaw_civilian_03_civilian_body_03_mesh', { preset: 'character', maxSize: 1024, normal: true, pivot: 'origin', mode: 'solo' }),
      A('characters_sp_civilian_head_alvin_tran_sp_alvin_tran_head_mesh', { preset: 'character', maxSize: 512, pivot: 'origin', mode: 'solo' }),
      A('characters_sp_civilian_head_beulah_wong_sp_beulah_wong_head_mesh', { preset: 'character', maxSize: 512, pivot: 'origin', mode: 'solo' }),
      A('characters_sp_civilian_head_jayson_li_sp_jayson_li_head_mesh', { preset: 'character', maxSize: 512, pivot: 'origin', mode: 'solo' }),
      A('characters_sp_friendly_chang_chang_head_sp_chang_head_mesh', { preset: 'character', maxSize: 512, pivot: 'origin', mode: 'solo' }),
      A('characters_sp_friendly_kovic_kovic_head_sp_kovic_head_mesh', { preset: 'character', maxSize: 512, pivot: 'origin', mode: 'solo' }),
      A('characters_sp_friendly_hanna_hanna_civilian_upperbody_mesh', { preset: 'character', maxSize: 1024, normal: true, pivot: 'origin', mode: 'solo' }),
      A('characters_sp_friendly_hanna_hanna_civilian_lowerbody_mesh', { preset: 'character', maxSize: 512, pivot: 'origin', mode: 'solo' }),
      A('characters_sp_friendly_hanna_hanna_head_sp_hanna_head_mesh', { preset: 'character', maxSize: 512, pivot: 'origin', mode: 'solo' }),
      A('characters_sp_friendly_hanna_hanna_head_sp_hanna_hair_mesh', { preset: 'character', maxSize: 512, pivot: 'origin', mode: 'solo' }),
      A('characters_sp_friendly_pac_sp_pac_civilian_upperbody_mesh', { preset: 'character', maxSize: 1024, normal: true, pivot: 'origin', mode: 'solo' }),
      A('characters_sp_friendly_pac_sp_pac_civilian_lowerbody_mesh', { preset: 'character', maxSize: 512, pivot: 'origin', mode: 'solo' }),
      A('characters_sp_friendly_pac_pac_head_sp_pac_head_mesh', { preset: 'character', maxSize: 512, pivot: 'origin', mode: 'solo' }),
      A('characters_sp_friendly_pac_pac_beanie_mesh', { preset: 'character', maxSize: 512, pivot: 'origin', mode: 'solo' }),
      A('characters_sp_friendly_irish_sp_irish_civilian_upperbody_mesh', { preset: 'character', maxSize: 1024, normal: true, pivot: 'origin', mode: 'solo' }),
      A('characters_sp_friendly_irish_sp_irish_civilian_lowerbody_mesh', { preset: 'character', maxSize: 512, pivot: 'origin', mode: 'solo' }),
      A('characters_sp_friendly_irish_irish_head_sp_irish_head_mesh', { preset: 'character', maxSize: 512, pivot: 'origin', mode: 'solo' }),
      A('characters_sp_friendly_child_sp_child_fullbody_mesh', { preset: 'character', maxSize: 512, pivot: 'origin', mode: 'solo' }),
    ],
  },
  buildings: {
    label: '载入建筑模块',
    items: [
      A('objects_architecture_skyscraper_generic_01_skyscraper_generic_01_b_mesh', { preset: 'building', maxSize: 512, normal: true, collide: true, night: 0.55 }),
      A('objects_architecture_skyscraper_generic_01_skyscraper_generic_01_c_mesh', { preset: 'building', maxSize: 512, normal: true, collide: true, night: 0.75 }),
      A('objects_architecture_skyscraper_generic_01_skyscraper_generic_01_d_mesh', { preset: 'building', maxSize: 512, normal: true, collide: true, night: 0.85 }),
      A('objects_architecture_skyscraper_generic_01_skyscraper_generic_01_e_mesh', { preset: 'building', maxSize: 512, normal: true, collide: true, night: 0.6 }),
      A('objects_architecture_skyscraper_generic_01_skyscraper_generic_01_f_mesh', { preset: 'building', maxSize: 512, normal: true, collide: true, night: 0.9 }),
      A('objects_architecture_skyscraper_generic_01_skyscraper_generic_separator_02_mesh', { preset: 'building', maxSize: 512, collide: true }),
      A('objects_architecture_skyscraper_generic_01_skyscraper_generic_separator_03_mesh', { preset: 'building', maxSize: 512, collide: true }),
      A('objects_architecture_skyscraper_generic_01_skyscraper_generic_straightroof_01_mesh', { preset: 'building', maxSize: 512, collide: true }),
      A('objects_architecture_skyscraper_generic_01_skyscraper_generic_solidblocks_256_big_01_mesh', { preset: 'building', maxSize: 512, collide: true }),
      A('objects_architecture_skyscraper_generic_01_skyscraper_generic_roofhouse_01_mesh', { preset: 'building', maxSize: 512, collide: true }),
      A('objects_architecture_skyscraper_generic_01_skyscraper_generic_ventilation_01_mesh', { preset: 'prop', maxSize: 512, collide: true }),
      A('objects_architecture_hk_skyscraper_02_hk_skyscraper_02_mesh', { preset: 'building', maxSize: 512, normal: true, collide: true, night: 0.7 }),
      A('objects_architecture_hk_skyscraper_02_hk_skyscraper_bottom_02_mesh', { preset: 'building', maxSize: 512, normal: true, collide: true }),
      A('objects_architecture_hk_skyscraper_02_hk_skyscraper_roof_02_mesh', { preset: 'building', maxSize: 512, collide: true }),
      A('objects_architecture_hk_skyscraper_03_hk_skyscraper_03_mesh', { preset: 'building', maxSize: 512, normal: true, collide: true, night: 0.8 }),
      // glass:false —— 立面贴图叫 t_window，会命中透明玻璃启发式，
      // 但这是一整栋地标塔楼，不能做成半透明（会整栋不写深度、被后面几何穿透）。
      // 关掉透明后仍保留 reflectiveFacade 的幕墙反射。
      A('objects_architecture_hk_skyscraper_05_hk_skyscraper_05_v2_backdrop_mesh', { preset: 'building', maxSize: 1024, normal: true, collide: true, mode: 'solo', night: 1.1, glass: false }),
      A('objects_architecture_skyscraper_waterfront_02_skyscraper_waterfront_02_backdrop_mesh', { preset: 'building', maxSize: 1024, normal: true, collide: true, mode: 'solo', night: 0.9 }),
      A('objects_architecture_hk_skyscraper_03_hk_skyscraper_bottom_03_mesh', { preset: 'building', maxSize: 512, normal: true, collide: true }),
      A('objects_architecture_skyscraper_waterfront_01_skyscraperwaterfront_01_mesh', { preset: 'building', maxSize: 512, normal: true, collide: true, night: 0.75 }),
      A('objects_architecture_skyscraper_waterfront_01_skyscraperwaterfront_roof_01_mesh', { preset: 'building', maxSize: 512, collide: true }),
      A('objects_architecture_skyscraper_waterfront_01_skyscraperwaterfront_baseplate_01_mesh', { preset: 'building', maxSize: 512, normal: true, collide: true }),
      A('levels_mp_mp_siege_architecture_mp_siege_skyscraperwaterfront_mp_siege_skyscraperwaterfront_mesh', { preset: 'building', maxSize: 512, normal: true, collide: true, mode: 'solo', night: 0.85 }),
      A('levels_mp_mp_siege_architecture_mp_siege_office_lshape_01_mp_siege_office_lshape_highrise_01_mesh', { preset: 'building', maxSize: 512, normal: true, collide: true, mode: 'solo', night: 0.8 }),
      A('levels_mp_mp_siege_architecture_mp_siege_office_lshape_01_mp_siege_office_lshape_highrise_02_mesh', { preset: 'building', maxSize: 512, normal: true, collide: true, mode: 'solo', night: 0.8 }),
      A('objects_architecture_ch_residentialbuilding_01_ch_residentialbuilding_01_merged_sp_shanghai_mesh', { preset: 'building', maxSize: 512, normal: true, collide: true, mode: 'solo', night: 0.9 }),
      A('objects_architecture_datacenter_02_animation_datacenter_02_animation_mesh', { preset: 'building', maxSize: 512, normal: true, collide: true, mode: 'solo', night: 0.5 }),
      A('levels_sp_sp_shanghai_objects_bd_building_emissive_01_mesh', { preset: 'building', maxSize: 1024, normal: true, collide: true, mode: 'solo', night: 1.6 }),
      A('levels_sp_sp_shanghai_objects_shanghaitower_01_shanghaitower_01_mesh', { preset: 'building', maxSize: 1024, normal: true, collide: true, mode: 'solo', night: 1.4 }),
      A('levels_sp_sp_shanghai_objects_architecture_shanghaihotel_shanghaihotel_floorlobbymerged_01_mesh', { preset: 'building', maxSize: 512, normal: true, collide: true, mode: 'solo' }),
      A('levels_sp_sp_shanghai_objects_architecture_shanghaihotelstaircase_01_shanghaihotelstaircase_01_mesh', { preset: 'building', maxSize: 512, normal: true, collide: true, mode: 'solo' }),
      A('levels_sp_sp_shanghai_objects_sp_shanghai_skyscraper_entrance_sp_shanghai_skyscraper_entrance_mesh', { preset: 'building', maxSize: 512, normal: true, collide: true, mode: 'solo' }),
    ],
  },
  streets: {
    label: '载入街道模块',
    items: [
      A('objects_architecture_roads_set_01_roadstraight_s1024x4096_mesh', { preset: 'ground', maxSize: 1024, normal: true }),
      A('objects_architecture_sidewalk_set_01_sidewalk_01_s512x512_mesh', { preset: 'ground', maxSize: 512, normal: true }),
      A('objects_architecture_sidewalk_set_01_sidewalk_01_s1024x512_mesh', { preset: 'ground', maxSize: 512, normal: true }),
      A('objects_architecture_sidewalk_set_01_sidewalk_01_s2048x512_mesh', { preset: 'ground', maxSize: 512, normal: true }),
      A('objects_architecture_sidewalk_set_01_sidewalk_01_f128x512_mesh', { preset: 'ground', maxSize: 512, normal: true }),
      A('objects_architecture_sidewalk_set_01_sidewalk_01_c512_large_mesh', { preset: 'ground', maxSize: 512, normal: true }),
      A('objects_architecture_sidewalk_set_01_sidewalk_01_c512x512_in_mesh', { preset: 'ground', maxSize: 512, normal: true }),
      A('objects_architecture_sidewalk_set_01_sidewalk_01_1024x1024_filler_mesh', { preset: 'ground', maxSize: 512, normal: true }),
      A('objects_architecture_storefront_alley_a_storefront_wall_2048_01_mesh', { preset: 'building', maxSize: 512, normal: true, collide: true }),
      A('objects_architecture_storefront_residential_r_wall_896_01_mesh', { preset: 'building', maxSize: 512, normal: true, collide: true }),
      A('objects_architecture_storefront_residential_r_innerwall_896_01_mesh', { preset: 'building', maxSize: 512, normal: true, collide: true }),
      A('objects_architecture_storefront_residential_r_pillar_128_01_mesh', { preset: 'building', maxSize: 512, normal: true, collide: true }),
      A('objects_architecture_storefront_shanty_residential_residential_03_1024_mesh', { preset: 'building', maxSize: 512, normal: true, collide: true }),
      A('objects_architecture_storefront_shanty_residential_residential_04_1024_mesh', { preset: 'building', maxSize: 512, normal: true, collide: true }),
      A('objects_architecture_storefront_commercial_fronts_c_storefront_front_896_01_mesh', { preset: 'building', maxSize: 512, normal: true, collide: true }),
      A('objects_architecture_storefront_commercial_fronts_c_storefront_door_896_01_mesh', { preset: 'building', maxSize: 512, normal: true, collide: true }),
      A('objects_architecture_storefront_commercial_fronts_c_storefront_topfront_896_01_mesh', { preset: 'building', maxSize: 512, normal: true, collide: true }),
      A('objects_architecture_storefront_shanty_rollupdoors_01_rollupdoor_768_01_shanghai_mesh', { preset: 'building', maxSize: 512, normal: true, collide: true }),
      A('objects_architecture_facadech_03_facadech_03_onefloor_c1024_mesh', { preset: 'building', maxSize: 512, normal: true, collide: true }),
      A('objects_architecture_facadech_03_facadech_03_onefloor_s1024_mesh', { preset: 'building', maxSize: 512, normal: true, collide: true }),
    ],
  },
  props: {
    label: '载入街景道具',
    items: [
      A('objects_props_cratewoodlight_01_cratewoodlight_01_mesh', { preset: 'prop', maxSize: 512, collide: true }),
      A('objects_props_cratemilitary_01_cratemilitary_01_mesh', { preset: 'prop', maxSize: 512, collide: true }),
      A('objects_props_cardboardbox_01_cardboardbox_01_closed_mesh', { preset: 'prop', maxSize: 512, collide: true }),
      A('objects_props_cardboardbox_01_cardboardbox_01_open_mesh', { preset: 'prop', maxSize: 512, collide: true }),
      A('objects_props_pallet_01_pallet_01_mesh', { preset: 'prop', maxSize: 512, collide: true }),
      A('objects_props_dumpster_01_dumpster_01_mesh', { preset: 'prop', maxSize: 512, normal: true, collide: true }),
      A('objects_props_oilbarrel_01_oilbarrel_01_mesh', { preset: 'prop', maxSize: 512, collide: true }),
      A('objects_props_trafficcone_01_trafficcone_01_mesh', { preset: 'prop', maxSize: 512, collide: true }),
      A('objects_props_concretebarrier_01_concretebarrier_01_destruction_mesh', { preset: 'prop', maxSize: 512, normal: true, collide: true }),
      A('objects_props_sandbagwall_01_sandbagwall_01_mesh', { preset: 'prop', maxSize: 512, normal: true, collide: true }),
      A('objects_props_bucket_01_bucket_01_mesh', { preset: 'prop', maxSize: 512, collide: true }),
      A('objects_props_marketstand_01_marketstand_01_basecluster_mesh', { preset: 'prop', maxSize: 512, normal: true, collide: true }),
      A('objects_props_chineselantern_01_chineselantern_01_mesh', { preset: 'prop', maxSize: 512, emissive: 0x552211, emissiveIntensity: 0.9 }),
      A('objects_props_planter_set_01_planterbox_01_256x128_2_mesh', { preset: 'prop', maxSize: 512, normal: true, collide: true }),
      A('objects_props_planter_set_01_planterwall_01_256x28_mesh', { preset: 'prop', maxSize: 512, normal: true, collide: true }),
      A('objects_props_planter_set_03_planter_set_03_1024x1024_mesh', { preset: 'prop', maxSize: 512, normal: true, collide: true }),
      A('objects_props_statuechinese_01_statuechinese_01_mesh', { preset: 'prop', maxSize: 512, normal: true, collide: true }),
      A('objects_lights_streetlight_02_streetlight_02_destruction_mesh', { preset: 'prop', maxSize: 512, normal: true, collide: true }),
      A('objects_lights_lightpedestrian_01_lightpedestrian_01_mesh', { preset: 'prop', maxSize: 512, normal: true, collide: true }),
      A('objects_props_streetprops_trafficlight_01_trafficlight_01_mesh', { preset: 'prop', maxSize: 512, normal: true, collide: true }),
      A('objects_props_storesign_01_storesign_01_large_mesh', { preset: 'prop', maxSize: 512, emissive: 0x221100, emissiveIntensity: 0.7 }),
      A('objects_props_signs_commercial_signs_sign_v_kanji_512_02_mesh', { preset: 'prop', maxSize: 512, emissive: 0x330f0a, emissiveIntensity: 1.1 }),
      A('objects_props_signs_neon_generic_neonsignsquarevertical_512x128_01_cyan_mesh', { preset: 'prop', maxSize: 512, emissive: 0x0a3340, emissiveIntensity: 1.4 }),
      A('objects_props_awning_01_awning_01_mesh', { preset: 'prop', maxSize: 512, normal: true }),
      A('objects_props_awningglass_01_awningglass_01_1024_mesh', { preset: 'prop', maxSize: 512, normal: true, collide: true }),
      A('objects_props_acunit_01_acunit_01_mesh', { preset: 'prop', maxSize: 512, collide: true }),
      A('objects_props_airconditioner_large_01_airconditioner_large_01_mesh', { preset: 'prop', maxSize: 512, collide: true }),
      A('objects_props_pipesystem_02_pipesystem_02d_mesh', { preset: 'prop', maxSize: 512 }),
      A('objects_props_metal_girder_01_metal_girder_01_mesh', { preset: 'prop', maxSize: 512, collide: true }),
      A('objects_props_debrispile_02_debrispile_02_b_mesh', { preset: 'prop', maxSize: 512, normal: true, collide: true }),
      A('objects_props_rubblepile_01_rubblepile_ground_01b_mesh', { preset: 'prop', maxSize: 512, normal: true }),
      A('objects_props_debrismicro_01_debrismicro_01_mesh', { preset: 'prop', maxSize: 512 }),
      A('objects_props_paperpile_01_paperpile_01_mesh', { preset: 'prop', maxSize: 512 }),
      A('objects_props_streetprops_trashcansmall_02_trashcansmall_02_mesh', { preset: 'prop', maxSize: 512, collide: true }),
      A('objects_props_cables_01_cable_bundle_medium_mesh', { preset: 'prop', maxSize: 512 }),
      A('objects_props_ladder_02_ladder02_5m_mesh', { preset: 'prop', maxSize: 512, collide: true }),
      A('objects_props_fenceparc_01_fenceparc_01_mesh', { preset: 'prop', maxSize: 512, collide: true }),
      A('objects_props_riotfence_riotfence_01_mesh', { preset: 'prop', maxSize: 512, collide: true }),
      A('objects_props_bicyclestationbike_01_bicyclestationbike_01_mesh', { preset: 'prop', maxSize: 512 }),
      A('objects_props_marblebench_02_marblebench_02_mesh', { preset: 'prop', maxSize: 512, collide: true }),
      A('objects_props_benchmodern_01_benchmodern_01_cluster_mesh', { preset: 'prop', maxSize: 512, collide: true }),
      A('objects_props_cafechair_01_cafechair_01_mesh', { preset: 'prop', maxSize: 512, collide: true }),
      A('objects_props_cafetable_01_cafetable_01_mesh', { preset: 'prop', maxSize: 512, collide: true }),
      A('objects_props_ammobag_01_ammobox_01_mesh', { preset: 'prop', maxSize: 512, collide: true }),
      A('objects_props_supplycase_01_supplycase_01_mesh', { preset: 'prop', maxSize: 512, collide: true }),
      A('objects_props_crossingbollard_crossingbollard_01_mesh', { preset: 'prop', maxSize: 512, collide: true }),
      A('objects_props_manholecover_01_manholecover_01_mesh', { preset: 'prop', maxSize: 512 }),
      A('objects_props_puddle_puddle_01_mesh', { preset: 'prop', maxSize: 256 }),
      A('objects_props_fountainrailing_01_fountainrailing_01_light_mesh', { preset: 'prop', maxSize: 512, collide: true }),
      A('levels_mp_mp_siege_placeholders_chinesesign_03_mesh', { preset: 'prop', maxSize: 512, normal: true }),
      A('levels_mp_mp_siege_placeholders_plantpot_01_backdrop_mesh', { preset: 'prop', maxSize: 512, normal: true, collide: true }),
      A('levels_mp_mp_siege_placeholders_railing_01_mesh', { preset: 'prop', maxSize: 512, collide: true }),
      A('levels_sp_sp_shanghai_objects_stone_lantern_01_stone_lantern_01_mesh', { preset: 'prop', maxSize: 512, normal: true, collide: true }),
      A('levels_sp_sp_shanghai_objects_sp_shanghai_roadsign_big_01_sp_shanghai_roadsign_big_01_mesh', { preset: 'prop', maxSize: 512, normal: true, collide: true }),
      A('levels_sp_sp_shanghai_objects_lightpedestrian_01_harbor_mesh', { preset: 'prop', maxSize: 512, normal: true, collide: true }),
    ],
  },
  landmark: {
    label: '载入地标与载具',
    items: [
      A('levels_sp_sp_shanghai_objects_shanghai_fountain_01_shanghai_fountain_01_mesh', { preset: 'prop', maxSize: 512, normal: true, collide: true, mode: 'solo' }),
      A('levels_sp_sp_shanghai_objects_shanghai_fountain_01_shanghai_fountain_curb_01_mesh', { preset: 'prop', maxSize: 512, normal: true, collide: true, mode: 'solo' }),
      A('levels_sp_sp_shanghai_objects_shanghai_fountain_01_shanghai_fountain_stairs_01_mesh', { preset: 'prop', maxSize: 512, normal: true, collide: true, mode: 'solo' }),
      A('levels_sp_sp_shanghai_objects_shanghai_fountain_01_shanghai_fountain_water_01_mesh', { preset: 'prop', maxSize: 512, mode: 'solo' }),
      A('levels_sp_sp_shanghai_objects_shanghai_fountain_01_shanghai_fountain_platform_07_mesh', { preset: 'prop', maxSize: 512, normal: true, collide: true, mode: 'solo' }),
      A('levels_sp_sp_shanghai_objects_shanghai_fountain_01_shanghai_fountainwall_08_mesh', { preset: 'prop', maxSize: 512, normal: true, collide: true, mode: 'solo' }),
      A('levels_sp_sp_shanghai_objects_shanghai_fountain_01_shanghai_fountainwall_09_mesh', { preset: 'prop', maxSize: 512, normal: true, collide: true, mode: 'solo' }),
      A('levels_sp_sp_shanghai_objects_shanghai_fountain_01_shanghai_fountainwall_11_mesh', { preset: 'prop', maxSize: 512, normal: true, collide: true, mode: 'solo' }),
      A('levels_sp_sp_shanghai_objects_plazaartwork_01_plazaartwork_01_mesh', { preset: 'prop', maxSize: 512, normal: true, collide: true, mode: 'solo' }),
      A('levels_sp_sp_shanghai_objects_sp_shanghai_boatriver_02_sp_shanghai_boatriver_02_mesh', { preset: 'prop', maxSize: 512, normal: true, collide: true, mode: 'solo' }),
      A('levels_sp_sp_shanghai_objects_canal_merged_platformwooden_x12_mesh', { preset: 'prop', maxSize: 512, normal: true, collide: true, mode: 'solo' }),
      A('levels_sp_sp_shanghai_objects_canal_merged_wl_straight_x6_mesh', { preset: 'prop', maxSize: 512, normal: true, collide: true, mode: 'solo' }),
      A('levels_sp_sp_shanghai_objects_canal_merged_stairs_x4_mesh', { preset: 'prop', maxSize: 512, normal: true, collide: true, mode: 'solo' }),
      A('levels_sp_sp_shanghai_objects_canal_merged_sidewalk_x3_mesh', { preset: 'prop', maxSize: 512, normal: true, mode: 'solo' }),
      A('levels_sp_sp_shanghai_objects_canal_merged_bkgrd_01_planter_01_mesh', { preset: 'prop', maxSize: 512, normal: true, mode: 'solo' }),
      A('levels_sp_sp_shanghai_objects_canal_merged_bkgrd_01_bushes_01_mesh', { preset: 'prop', maxSize: 512, normal: true, mode: 'solo' }),
      A('levels_sp_sp_shanghai_objects_canal_merged_bkgrd_01_trees_01_mesh', { preset: 'prop', maxSize: 512, normal: true, mode: 'solo' }),
      A('objects_vehicles_carcivilian_01_carcivilian_01_mesh', { preset: 'vehicle', maxSize: 1024, normal: true, collide: true, mode: 'solo' }),
      A('objects_vehicles_carcivilian_02_carcivilian_02_mesh', { preset: 'vehicle', maxSize: 1024, normal: true, collide: true, mode: 'solo' }),
      A('objects_vehicles_truckch_01_truckch_01_mesh', { preset: 'vehicle', maxSize: 1024, normal: true, collide: true, mode: 'solo' }),
      A('levels_sp_sp_shanghai_objects_policecarshanghai_01_policecarshanghai_01_mesh', { preset: 'vehicle', maxSize: 1024, normal: true, collide: true, mode: 'solo' }),
      A('levels_sp_sp_shanghai_objects_sp_shanghai_van01_sp_shanghai_van01_broken_mesh', { preset: 'vehicle', maxSize: 1024, normal: true, collide: true, mode: 'solo' }),
      A('gameplay_vehicles_ch_mbt_type99_spec_ch_mbt_type99_sp_shanghaichase_mesh', { preset: 'vehicle', maxSize: 1024, normal: true, collide: true, mode: 'solo' }),
      // 这架残骸的 _d 贴图偏暗偏平（实测平均亮度 41、方差 651；普通轿车是 79 / 5443），
      // 沿用车辆预设（metalness .45、roughness .38、env 1.0）时漫反射被金属项吃掉不少，
      // 整机偏"裸金属"。法线贴图丢 Z 的问题由加载器统一修复（rebuildNormalZ），
      // 这里只做轻度收敛：哑光、降低金属度与环境反射权重，并略微提亮反照率。
      A('gameplay_vehicles_ch_lthe_z-9_ch_lthe_z-9_wreck_mesh', {
        preset: 'vehicle', maxSize: 1024, normal: true, collide: true, mode: 'solo',
        mat: { metalness: 0.20, roughness: 0.60, env: 0.60, coat: 0.08, coatRough: 0.70, normalScale: 0.8, albedo: 1.2 },
      }),
      A('objects_vehicles_carcivilian_01_carcivilian_01_wreck_cluster_mesh', { preset: 'vehicle', maxSize: 512, normal: true, collide: true, mode: 'solo' }),
      A('objects_props_siegeskyline_shanghaitower_01_mesh', { preset: 'backdrop', maxSize: 512, pivot: 'base', mode: 'solo', night: 1.5, noFog: true }),
      A('objects_props_siegeskyline_shanghaitower_02_mesh', { preset: 'backdrop', maxSize: 512, pivot: 'base', mode: 'solo', night: 1.5, noFog: true }),
    ],
  },
};

/* ---------------------------------------------------------- 批量加载 */
export async function loadAll(tex, onProgress) {
  const assets = new Map();
  const glowMats = [];
  const bgMats = [];
  const streetMats = [];      // 路面/人行道：夜里由 NightLightPool 注入"灯位光池"着色器
  const litMats = [];         // 街面物体（道具/车辆）：吃路灯光贴图的余光
  const names = [];
  for (const g of Object.values(GROUPS)) for (const it of g.items) names.push(it.f);
  const total = names.length;
  let done = 0;

  for (const [key, grp] of Object.entries(GROUPS)) {
    onProgress && onProgress({ phase: grp.label, done, total });
    // 每组的贴图并行解码，几何体逐个解析（避免长任务阻塞）
    const jobs = grp.items.map((it) => (async () => {
      const opt = {
        preset: it.preset,
        // 近景建筑使用 1024 边长以保住立面窗格；角色/小物维持清单尺寸。
        maxSize: it.preset === 'building' ? Math.max(it.maxSize || 512, 1024) : (it.maxSize || 512),
        loadNormal: !!it.normal,
        pivot: it.pivot || 'base',
        side: it.side,
        emissive: it.emissive,
        emissiveIntensity: it.emissiveIntensity,
        fog: !it.noFog,
        // 透传玻璃开关：贴图名命中 "window/glass" 时是否真的做成半透明。
        // 整栋楼的立面贴图常带 window 字样，必须能按资产显式关掉。
        glass: it.glass,
        // 材质微调：整组透传，由 makeMaterial 里统一取值
        mat: it.mat || null,
      };
      let asset = await loadAsset(tex, it.f, opt);
      if (!asset) { done++; onProgress && onProgress({ phase: grp.label, done, total }); return; }

      if (it.clipY !== undefined) {
        const keep = asset.parts.map((p) => ({
          geometry: clipGeometryY(p.geometry, it.clipY, 1e9),
          material: p.material,
        }));
        for (const p of asset.parts) p.geometry.dispose();
        asset.parts = keep;
      }
      asset.cfg = it;
      asset.glow = it.night || 0;
      if (it.night) {
        for (const p of asset.parts) {
          let m = p.material;
          // 程序化材质按 kind+variant 缓存并共享：直接往上写自发光会污染
          // 其它共用该材质的建筑，必须克隆一份（并重新挂三平面着色器）
          if (m.userData && m.userData.proc) {
            m = m.clone();
            reattachProcShader(m);
            p.material = m;
          }
          m.emissive = new THREE.Color(0xffc27a);
          // 自发光只走「窗户掩膜」：
          //   程序化材质 → 自带窗格遮罩（与重投影 UV 对齐）
          //   真实贴图   → 由立面贴图的暗区推导（玻璃是暗区、墙体是亮区）
          m.emissiveMap = windowMaskFor(m) || deriveWindowMask(m.map) || m.map;
          m.emissiveIntensity = 0;
          m.userData.glow = it.night;
          glowMats.push(m);
        }
      }
      if (it.preset === 'backdrop') {
        for (const p of asset.parts) bgMats.push(p.material);
      }
      if (it.preset === 'ground') {
        for (const p of asset.parts) if (p.material) streetMats.push(p.material);
      }
      // 道具/车辆夜里要吃到路灯光贴图的余光（竖版灯箱招牌、弃车等）。
      // 程序化材质按 kind+variant 全局缓存共享，必须克隆后再交给夜光池 patch，
      // 否则会把同一份材质上的改动污染到共用它的建筑。
      if (it.preset === 'prop' || it.preset === 'vehicle') {
        for (const p of asset.parts) {
          let m = p.material;
          if (m && m.userData && m.userData.proc) {
            m = m.clone();
            reattachProcShader(m);
            p.material = m;
          }
          if (m) litMats.push(m);
        }
      }
      assets.set(it.f, asset);
      done++;
      onProgress && onProgress({ phase: grp.label, done, total });
    })());
    await Promise.all(jobs);
    await yieldFrame();
  }
  return { assets, glowMats, bgMats, streetMats, litMats, total };
}

/* ---------------------------------------------------------- 世界实例化 */
const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);

export class WorldBuilder {
  constructor(scene, assets, boxes) {
    this.scene = scene;
    this.assets = assets;
    this.boxes = boxes;
    this.records = new Map();   // assetName -> [{x,y,z,yaw,scale,tint}]
    this.objects = [];
    this.stats = { instances: 0, meshes: 0, tris: 0 };
  }

  /** 记录一次摆放；返回所创建的 record 以便后续操作 */
  place(name, x, y, z, yaw = 0, o = {}) {
    const asset = this.assets.get(name);
    if (!asset) return null;
    const rec = {
      x, y, z, yaw,
      scale: o.scale ?? 1,
      tint: o.tint || null,
      tiltX: o.tiltX || 0,
      tiltZ: o.tiltZ || 0,
    };
    let arr = this.records.get(name);
    if (!arr) { arr = []; this.records.set(name, arr); }
    arr.push(rec);

    const doCollide = o.collide !== undefined ? o.collide : !!asset.cfg?.collide;
    if (doCollide) this.addCollider(asset, rec, o);
    return rec;
  }

  addCollider(asset, rec, o = {}) {
    const s = rec.scale;
    const cx = (asset.min.x + asset.max.x) / 2, cy = (asset.min.y + asset.max.y) / 2, cz = (asset.min.z + asset.max.z) / 2;
    const hx = (asset.max.x - asset.min.x) / 2 * s;
    const hy = (asset.max.y - asset.min.y) / 2 * s;
    const hz = (asset.max.z - asset.min.z) / 2 * s;
    const c = Math.cos(rec.yaw), sn = Math.sin(rec.yaw);
    const wx = c * (cx * s) + sn * (cz * s);
    const wz = -sn * (cx * s) + c * (cz * s);
    const hxa = Math.max(hx, 0.02), hya = Math.max(hy, 0.02), hza = Math.max(hz, 0.02);
    const shrink = o.shrink ?? 0.94;
    this.boxes.add(
      rec.x + wx, rec.y + cy * s, rec.z + wz,
      hxa * shrink, hya, hza * shrink, rec.yaw, colliderKind(asset.name)
    );
  }

  /** 只加碰撞体，不渲染（用于隐形墙/地形限制） */
  addBoxOnly(cx, cy, cz, hx, hy, hz, yaw = 0) {
    this.boxes.add(cx, cy, cz, hx, hy, hz, yaw);
  }

  build() {
    this.byAsset = new Map();
    for (const [name, list] of this.records) {
      const asset = this.assets.get(name);
      if (!asset) continue;
      const solo = asset.cfg && asset.cfg.mode === 'solo';
      this.byAsset.set(name, { n: list.length, tris: asset.tris * list.length, solo });
      if (solo) this.buildSolo(asset, list);
      else this.buildInstanced(asset, list);
    }
    this.records.clear();
    return this.stats;
  }

  /** 三角面消耗排行（性能诊断） */
  topAssets(n = 12) {
    if (!this.byAsset) return [];
    return [...this.byAsset.entries()]
      .map(([k, v]) => ({ name: k, ...v }))
      .sort((a, b) => b.tris - a.tris)
      .slice(0, n);
  }

  /** 只统计会被整体提交（InstancedMesh，不做视锥剔除）的三角面 */
  instancedTris() {
    let t = 0;
    if (!this.byAsset) return 0;
    for (const v of this.byAsset.values()) if (!v.solo) t += v.tris;
    return t;
  }

  buildInstanced(asset, list) {
    const anyTint = list.some((r) => r.tint);
    for (const part of asset.parts) {
      const im = new THREE.InstancedMesh(part.geometry, part.material, list.length);
      im.frustumCulled = false;
      for (let i = 0; i < list.length; i++) {
        const r = list[i];
        _q.setFromAxisAngle(UP, r.yaw);
        _v.set(r.x, r.y, r.z);
        _s.setScalar(r.scale);
        im.setMatrixAt(i, _m4.compose(_v, _q, _s));
        if (anyTint) im.setColorAt(i, r.tint || WHITE_TINT);
      }
      im.instanceMatrix.needsUpdate = true;
      if (anyTint && im.instanceColor) im.instanceColor.needsUpdate = true;
      im.userData.batch = asset.name;
      // 道具批（垃圾桶/护栏/箱柜等）参与投影：夜光池的投影路灯需要街边
      // 道具做遮挡体，否则灯下没有可投射阴影的物体，影子无从谈起。
      im.castShadow = !!(asset.cfg?.shadow) || asset.cfg?.preset === 'prop';
      im.receiveShadow = true;
      this.scene.add(im);
      this.objects.push(im);
      this.stats.meshes++;
      this.stats.instances += list.length;
      this.stats.tris += asset.tris * list.length;
    }
  }

  buildSolo(asset, list) {
    for (const r of list) {
      const g = new THREE.Group();
      for (const part of asset.parts) {
        let mat = part.material;
        if (r.tint) {
          mat = mat.clone();
          reattachProcShader(mat);   // clone 会丢掉程序化材质的三平面着色器钩子
          mat.color.multiply(r.tint);
        }
        const mesh = new THREE.Mesh(part.geometry, mat);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        g.add(mesh);
        this.stats.meshes++;
      }
      g.position.set(r.x, r.y, r.z);
      g.rotation.set(r.tiltX || 0, r.yaw, r.tiltZ || 0);
      g.scale.setScalar(r.scale);
      g.userData.asset = asset.name;
      this.scene.add(g);
      this.objects.push(g);
      this.stats.instances++;
      this.stats.tris += asset.tris;
    }
  }
}

const WHITE_TINT = new THREE.Color(1, 1, 1);

/** 依据资产名推断碰撞体表面材质，用于弹着特效/音效 */
export function colliderKind(name) {
  const n = name.toLowerCase();
  if (/glass|window/.test(n)) return 'glass';
  if (/(metal|pipe|girder|railing|fence|barrel|ladder|light|sign|car|truck|tank|heli|van|vehicle|dumpster|lamp)/.test(n)) return 'metal';
  if (/(wood|crate|pallet|plank|door|cardboard|bench|table|chair|market|barrier)/.test(n)) return 'wood';
  return 'concrete';
}
