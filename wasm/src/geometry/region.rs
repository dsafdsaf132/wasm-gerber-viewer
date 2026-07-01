#[derive(Clone, Debug)]
pub(crate) enum RegionSegment {
    Line {
        start: [f32; 2],
        end: [f32; 2],
    },
    Arc {
        start: [f32; 2],
        end: [f32; 2],
        center: [f32; 2],
        radius: f32,
        start_angle: f32,
        sweep_angle: f32,
        clamp_sweep: bool,
    },
}

#[derive(Clone, Debug, Default)]
pub(crate) struct RegionContour {
    pub points: Vec<[f32; 2]>,
    pub segments: Vec<RegionSegment>,
    pub has_arc: bool,
}

impl RegionContour {
    pub(crate) fn is_empty(&self) -> bool {
        self.points.is_empty() && self.segments.is_empty()
    }

    pub(crate) fn push_start(&mut self, point: [f32; 2]) -> Result<(), String> {
        self.points.try_reserve(1).map_err(|_| {
            "Gerber region is too large to render: not enough memory for region points".to_string()
        })?;
        self.points.push(point);
        Ok(())
    }

    pub(crate) fn push_line(&mut self, start: [f32; 2], end: [f32; 2]) -> Result<(), String> {
        self.points.try_reserve(1).map_err(|_| {
            "Gerber region is too large to render: not enough memory for region points".to_string()
        })?;
        self.segments.try_reserve(1).map_err(|_| {
            "Gerber region is too large to render: not enough memory for region segments"
                .to_string()
        })?;
        if self.points.is_empty() {
            self.points.push(start);
        }
        self.points.push(end);
        self.segments.push(RegionSegment::Line { start, end });
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn push_arc(
        &mut self,
        start: [f32; 2],
        end: [f32; 2],
        center: [f32; 2],
        radius: f32,
        start_angle: f32,
        sweep_angle: f32,
    ) -> Result<(), String> {
        self.push_arc_with_sweep_clamp(start, end, center, radius, start_angle, sweep_angle, false)
    }

    pub(crate) fn push_arc_with_sweep_clamp(
        &mut self,
        start: [f32; 2],
        end: [f32; 2],
        center: [f32; 2],
        radius: f32,
        start_angle: f32,
        sweep_angle: f32,
        clamp_sweep: bool,
    ) -> Result<(), String> {
        self.points.try_reserve(1).map_err(|_| {
            "Gerber region is too large to render: not enough memory for region points".to_string()
        })?;
        self.segments.try_reserve(1).map_err(|_| {
            "Gerber region is too large to render: not enough memory for region segments"
                .to_string()
        })?;
        if self.points.is_empty() {
            self.points.push(start);
        }
        self.points.push(end);
        self.segments.push(RegionSegment::Arc {
            start,
            end,
            center,
            radius,
            start_angle,
            sweep_angle,
            clamp_sweep,
        });
        self.has_arc = true;
        Ok(())
    }
}
