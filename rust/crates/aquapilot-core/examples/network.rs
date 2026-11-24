use aquapilot_core::asm2d::{Params, to_asm2d};
use aquapilot_core::network::{
    Edge, Influent, Network, Reactor, ReactorKind, Recycle, StepOptions,
};

fn main() {
    let initial = to_asm2d(312.0, 31.5, 0.0, 4.6, 0.0, 8.0, 3000.0);
    let mk = |id: &str, kind, volume| Reactor {
        id: id.into(),
        kind,
        volume,
        state: initial,
        kla: 0.0,
        integral: 0.0,
        o2_demand: 0.0,
    };
    let reactors = vec![
        mk("anaerobic", ReactorKind::Anaerobic, 3000.0),
        mk("anoxic", ReactorKind::Anoxic, 4500.0),
        mk("aerobic1", ReactorKind::Aerobic, 5750.0),
        mk("aerobic2", ReactorKind::Aerobic, 5750.0),
        mk("aerobic3", ReactorKind::Aerobic, 5750.0),
    ];
    let edges = vec![
        Edge {
            from: None,
            to: 0,
            flow: 1546.0,
            recycle: Recycle::None,
        },
        Edge {
            from: Some(4),
            to: 0,
            flow: 454.0,
            recycle: Recycle::Ras,
        },
        Edge {
            from: Some(0),
            to: 1,
            flow: 2000.0,
            recycle: Recycle::None,
        },
        Edge {
            from: Some(1),
            to: 2,
            flow: 2000.0,
            recycle: Recycle::None,
        },
        Edge {
            from: Some(2),
            to: 3,
            flow: 2000.0,
            recycle: Recycle::None,
        },
        Edge {
            from: Some(3),
            to: 4,
            flow: 2000.0,
            recycle: Recycle::None,
        },
    ];
    let mut net = Network::new(reactors, edges);
    let inf = Influent {
        flow: 1546.0,
        cod: 312.0,
        nh: 31.5,
        tn: 44.0,
        tp: 4.6,
        ss: 184.0,
        alkalinity: 8.0,
    };
    let opts = StepOptions {
        dt_h: 0.5,
        temperature_c: 20.0,
        bio_p: true,
        suppression: 1.0,
        do_setpoint: 2.0,
        aeration_capacity: 0.976,
    };
    for _ in 0..48 {
        net.step(inf, 4428.0, &Params::default(), opts);
    }
    for r in &net.reactors {
        println!("{} {:?}", r.id, r.state.v);
    }
}
