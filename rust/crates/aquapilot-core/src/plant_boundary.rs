//! Plant boundary: COD / N / P mass books and sludge-line closure.
//!
//! Ported from the TypeScript oracle `src/sim/plantBoundary.ts`. The accounting
//! rows are integrated every step from independently measured fluxes; the
//! residual is never back-solved from a boundary balance.

use crate::asm2d::COD_PER_VSS;
use crate::sludge_line::{Filtrate, SludgeLine};

pub const PLANT_BALANCE_UNCLOSED: &str = "PLANT_BALANCE_UNCLOSED";
pub const ASM2D_STATE_INVALID: &str = "ASM2D_STATE_INVALID";
pub const BALANCE_TOLERANCE_PCT: f64 = 0.05;
pub const COD_PER_CH4_KG: f64 = 4.0;
const N_PER_BIOMASS: f64 = 0.07;
const P_PER_BIOMASS: f64 = 0.032;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BalanceRow {
    pub inflow_kg: f64,
    pub effluent_kg: f64,
    pub wasted_kg: f64,
    pub methane_cod_kg: f64,
    pub oxidized_kg: f64,
    pub denitrified_kg: f64,
    pub inventory_change_kg: f64,
    pub recycle_kg: f64,
    pub residual_kg: f64,
    pub residual_pct: f64,
    pub closed: bool,
}

impl Default for BalanceRow {
    fn default() -> Self {
        Self {
            inflow_kg: 0.0,
            effluent_kg: 0.0,
            wasted_kg: 0.0,
            methane_cod_kg: 0.0,
            oxidized_kg: 0.0,
            denitrified_kg: 0.0,
            inventory_change_kg: 0.0,
            recycle_kg: 0.0,
            residual_kg: 0.0,
            residual_pct: 0.0,
            closed: true,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Inventory {
    pub biomass_kg: f64,
    pub cod_kg: f64,
    pub n_kg: f64,
    pub p_kg: f64,
    pub previous_cod_kg: f64,
    pub previous_n_kg: f64,
    pub previous_p_kg: f64,
    pub seeded: bool,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct PlantError {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PlantBoundaryState {
    pub enabled: bool,
    pub sludge_line: SludgeLine,
    pub cod: BalanceRow,
    pub n: BalanceRow,
    pub p: BalanceRow,
    pub errors: Vec<PlantError>,
    pub inventory: Inventory,
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct WaterQuality {
    pub flow: f64,
    pub cod: f64,
    pub nh: f64,
    pub tn: f64,
    pub tp: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct InventoryInput {
    pub cod_kg: f64,
    pub n_kg: f64,
    pub p_kg: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct ComponentLoads {
    pub cod_in_kg: f64,
    pub cod_eff_kg: f64,
    pub n_in_kg: f64,
    pub n_eff_kg: f64,
    pub p_in_kg: f64,
    pub p_eff_kg: f64,
    pub waste_cod_kg: f64,
    pub waste_n_kg: f64,
    pub waste_p_kg: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct BalanceInput {
    pub influent: WaterQuality,
    pub effluent: WaterQuality,
    pub dt_h: f64,
    pub biomass_kg: f64,
    pub inventory: Option<InventoryInput>,
    pub oxidized_cod_kg_h: f64,
    pub denitrified_n_kg_h: f64,
    pub clamp_cod_kg_h: f64,
    pub clamp_n_kg_h: f64,
    pub clamp_p_kg_h: f64,
    pub wasted_dry_kg: f64,
    pub component: Option<ComponentLoads>,
}

fn load_kg(concentration: f64, flow_m3h: f64, dt_h: f64) -> f64 {
    (concentration.max(0.0) * flow_m3h.max(0.0) * dt_h) / 1000.0
}

fn finalize(row: &mut BalanceRow) {
    let supply = row.inflow_kg + row.recycle_kg;
    let residual = supply
        - row.effluent_kg
        - row.wasted_kg
        - row.methane_cod_kg
        - row.oxidized_kg
        - row.denitrified_kg
        - row.inventory_change_kg;
    row.residual_kg = residual;
    row.residual_pct = if supply > 1e-9 {
        residual.abs() / supply
    } else {
        0.0
    };
    row.closed = row.residual_pct <= BALANCE_TOLERANCE_PCT;
}

impl PlantBoundaryState {
    pub fn new(enabled: bool) -> Self {
        Self {
            enabled,
            sludge_line: SludgeLine::new(enabled),
            cod: BalanceRow::default(),
            n: BalanceRow::default(),
            p: BalanceRow::default(),
            errors: Vec::new(),
            inventory: Inventory::default(),
        }
    }

    pub fn record_error(&mut self, code: &str, message: &str) {
        if let Some(existing) = self.errors.iter_mut().find(|e| e.code == code) {
            existing.message = message.to_string();
        } else {
            self.errors.push(PlantError {
                code: code.to_string(),
                message: message.to_string(),
            });
        }
    }

    pub fn update(&mut self, input: &BalanceInput) {
        let inv_cod = input
            .inventory
            .map(|i| i.cod_kg)
            .unwrap_or(input.biomass_kg * COD_PER_VSS);
        let inv_n = input
            .inventory
            .map(|i| i.n_kg)
            .unwrap_or(input.biomass_kg * N_PER_BIOMASS);
        let inv_p = input
            .inventory
            .map(|i| i.p_kg)
            .unwrap_or(input.biomass_kg * P_PER_BIOMASS);

        let inv_before = self.inventory;
        let inv_cod_delta = if inv_before.seeded {
            inv_cod - inv_before.previous_cod_kg
        } else {
            0.0
        };
        let inv_n_delta = if inv_before.seeded {
            inv_n - inv_before.previous_n_kg
        } else {
            0.0
        };
        let inv_p_delta = if inv_before.seeded {
            inv_p - inv_before.previous_p_kg
        } else {
            0.0
        };
        self.inventory.biomass_kg = input.biomass_kg;
        self.inventory.cod_kg = inv_cod;
        self.inventory.n_kg = inv_n;
        self.inventory.p_kg = inv_p;

        let filtrate: Filtrate = self.sludge_line.dewatering.filtrate;
        let recycle_cod_kg = load_kg(filtrate.cod_kg_m3, filtrate.flow_m3h, input.dt_h);
        let recycle_n_kg = load_kg(filtrate.nh4_n_kg_m3, filtrate.flow_m3h, input.dt_h);
        let recycle_p_kg = load_kg(filtrate.tp_kg_m3, filtrate.flow_m3h, input.dt_h);

        let component = input.component;
        let wasted_cod_kg = component
            .map(|c| c.waste_cod_kg)
            .unwrap_or(input.wasted_dry_kg * COD_PER_VSS);
        let wasted_n_kg = component
            .map(|c| c.waste_n_kg)
            .unwrap_or(input.wasted_dry_kg * N_PER_BIOMASS);
        let wasted_p_kg = component
            .map(|c| c.waste_p_kg)
            .unwrap_or(input.wasted_dry_kg * P_PER_BIOMASS);

        let cod_in = component.map(|c| c.cod_in_kg).unwrap_or(load_kg(
            input.influent.cod,
            input.influent.flow,
            input.dt_h,
        ));
        let cod_eff = component.map(|c| c.cod_eff_kg).unwrap_or(load_kg(
            input.effluent.cod,
            input.effluent.flow,
            input.dt_h,
        ));
        let n_in = component.map(|c| c.n_in_kg).unwrap_or(load_kg(
            input.influent.tn,
            input.influent.flow,
            input.dt_h,
        ));
        let n_eff = component.map(|c| c.n_eff_kg).unwrap_or(load_kg(
            input.effluent.tn,
            input.effluent.flow,
            input.dt_h,
        ));
        let p_in = component.map(|c| c.p_in_kg).unwrap_or(load_kg(
            input.influent.tp,
            input.influent.flow,
            input.dt_h,
        ));
        let p_eff = component.map(|c| c.p_eff_kg).unwrap_or(load_kg(
            input.effluent.tp,
            input.effluent.flow,
            input.dt_h,
        ));

        let oxidized_cod_kg = input.oxidized_cod_kg_h.max(0.0) * input.dt_h;
        let denitrified_n_kg = input.denitrified_n_kg_h.max(0.0) * input.dt_h;
        let clamp_cod_kg = input.clamp_cod_kg_h.max(0.0) * input.dt_h;
        let clamp_n_kg = input.clamp_n_kg_h.max(0.0) * input.dt_h;
        let clamp_p_kg = input.clamp_p_kg_h.max(0.0) * input.dt_h;

        self.cod.inflow_kg += cod_in;
        self.cod.effluent_kg += cod_eff;
        self.cod.wasted_kg += wasted_cod_kg;
        self.cod.recycle_kg += recycle_cod_kg;
        self.cod.inventory_change_kg += inv_cod_delta;
        self.cod.oxidized_kg += oxidized_cod_kg + clamp_cod_kg;
        let methane_kg_d = self.sludge_line.digester.gas.methane_kg_d;
        self.cod.methane_cod_kg += methane_kg_d * COD_PER_CH4_KG * (input.dt_h / 24.0);

        self.n.inflow_kg += n_in;
        self.n.effluent_kg += n_eff;
        self.n.wasted_kg += wasted_n_kg;
        self.n.recycle_kg += recycle_n_kg;
        self.n.inventory_change_kg += inv_n_delta;
        self.n.denitrified_kg += denitrified_n_kg + clamp_n_kg;

        self.p.inflow_kg += p_in;
        self.p.effluent_kg += p_eff;
        self.p.wasted_kg += wasted_p_kg + clamp_p_kg;
        self.p.recycle_kg += recycle_p_kg;
        self.p.inventory_change_kg += inv_p_delta;

        finalize(&mut self.cod);
        finalize(&mut self.n);
        finalize(&mut self.p);

        self.inventory.previous_cod_kg = inv_cod;
        self.inventory.previous_n_kg = inv_n;
        self.inventory.previous_p_kg = inv_p;
        self.inventory.seeded = true;

        if !self.cod.closed || !self.n.closed || !self.p.closed {
            let message = format!(
                "质量平衡残差超阈值：COD {:.1}%，N {:.1}%，P {:.1}%",
                self.cod.residual_pct * 100.0,
                self.n.residual_pct * 100.0,
                self.p.residual_pct * 100.0
            );
            self.record_error(PLANT_BALANCE_UNCLOSED, &message);
        }
    }

    pub fn reset(&mut self) {
        self.cod = BalanceRow::default();
        self.n = BalanceRow::default();
        self.p = BalanceRow::default();
        self.inventory = Inventory::default();
        self.errors.clear();
        self.sludge_line = SludgeLine::new(self.enabled);
    }
}
