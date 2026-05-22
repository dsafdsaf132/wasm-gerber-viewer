#version 300 es
precision highp float;
in highp vec2 vPosition;
in highp float vStartAngle;
in highp float vSweepAngle;
out lowp vec4 fragColor;

const float TWO_PI = 6.28318530718;

float normalizeAngle(float angle) {
    float normalized = mod(angle, TWO_PI);
    if (normalized < 0.0) {
        normalized += TWO_PI;
    }
    return normalized;
}

void main() {
    if (dot(vPosition, vPosition) > 1.0) {
        discard;
    }

    float angle = normalizeAngle(atan(vPosition.y, vPosition.x));
    float startAngle = normalizeAngle(vStartAngle);
    float sweep = clamp(vSweepAngle, -TWO_PI, TWO_PI);
    float endAngle = normalizeAngle(startAngle + sweep);

    bool inRange;
    if (abs(sweep) >= TWO_PI - 0.00001) {
        inRange = true;
    } else if (sweep > 0.0) {
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

    if (!inRange) {
        discard;
    }

    fragColor = vec4(1.0);
}
