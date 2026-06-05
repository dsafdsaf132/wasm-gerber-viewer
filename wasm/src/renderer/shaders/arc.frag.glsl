#version 300 es
precision highp float;
in highp vec2 vPosition;
in highp float vRadius;
in highp float vStartAngle;
in highp float vSweepAngle;
in highp float vThickness;
in highp float vOutlineThickness;
uniform lowp vec4 color;
out lowp vec4 fragColor;

const float PI = 3.14159265359;
const float TWO_PI = 6.28318530718;

float normalizeAngle(float angle) {
    float normalized = mod(angle, TWO_PI);
    if (normalized < 0.0) {
        normalized += TWO_PI;
    }
    return normalized;
}

void main() {
    float dist = length(vPosition);
    float angle = atan(vPosition.y, vPosition.x);

    angle = normalizeAngle(angle);
    float startAngle = normalizeAngle(vStartAngle);
    float endAngle = normalizeAngle(startAngle + vSweepAngle);

    float innerRadius = vRadius - vThickness * 0.5;
    float outerRadius = vRadius + vThickness * 0.5;

    bool inRange;
    if (vSweepAngle > 0.0) {
        if (endAngle > startAngle) {
            inRange = angle >= startAngle && angle <= endAngle;
        } else {
            inRange = angle >= startAngle || angle <= endAngle;
        }
    } else {
        if (endAngle < startAngle) {
            inRange = angle <= startAngle && angle >= endAngle;
        } else {
            inRange = angle <= startAngle || angle >= endAngle;
        }
    }

    bool inArcBody = dist >= innerRadius && dist <= outerRadius && inRange;
    bool hasCaps = abs(vSweepAngle) < TWO_PI - 0.001;
    bool inCap = false;
    bool inOutline = false;
    if (hasCaps) {
        float halfThickness = vThickness * 0.5;
        vec2 startPoint = vec2(cos(vStartAngle), sin(vStartAngle)) * vRadius;
        vec2 endPoint = vec2(cos(vStartAngle + vSweepAngle), sin(vStartAngle + vSweepAngle)) * vRadius;
        float startDistance = length(vPosition - startPoint);
        float endDistance = length(vPosition - endPoint);
        inCap = startDistance <= halfThickness
            || endDistance <= halfThickness;
        if (vOutlineThickness > 0.0) {
            float innerCapRadius = max(halfThickness - vOutlineThickness, 0.0);
            inOutline = (startDistance >= innerCapRadius && startDistance <= halfThickness)
                || (endDistance >= innerCapRadius && endDistance <= halfThickness);
        }
    }

    if (vOutlineThickness > 0.0) {
        bool hasInnerBoundary = innerRadius > 0.0;
        bool nearOuter = dist >= max(outerRadius - vOutlineThickness, innerRadius)
            && dist <= outerRadius;
        bool nearInner = hasInnerBoundary
            && dist >= innerRadius
            && dist <= min(innerRadius + vOutlineThickness, outerRadius);
        inOutline = inOutline || (inRange && (nearOuter || nearInner));
    }

    if ((vOutlineThickness > 0.0 && !inOutline)
        || (vOutlineThickness <= 0.0 && !inArcBody && !inCap)) {
        discard;
    }

    fragColor = color;
}
