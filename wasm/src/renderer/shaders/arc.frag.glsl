#version 300 es
precision highp float;
in highp vec2 vPosition;
in highp float vRadius;
in highp float vStartAngle;
in highp float vSweepAngle;
in highp float vThickness;
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
    if (hasCaps) {
        float halfThickness = vThickness * 0.5;
        vec2 startPoint = vec2(cos(vStartAngle), sin(vStartAngle)) * vRadius;
        vec2 endPoint = vec2(cos(vStartAngle + vSweepAngle), sin(vStartAngle + vSweepAngle)) * vRadius;
        inCap = length(vPosition - startPoint) <= halfThickness
            || length(vPosition - endPoint) <= halfThickness;
    }

    if (!inArcBody && !inCap) {
        discard;
    }

    fragColor = color;
}
