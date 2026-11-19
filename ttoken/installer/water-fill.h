// TTOken Code installer: water filling the TTOken mark as installation advances.
// Coordinates use the mark's 56 x 48 design grid with y pointing down; times are in seconds.
#pragma once
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <utility>

namespace water_fill {

constexpr double kWidth = 56;
constexpr double kHeight = 48;
constexpr int kColumns = 41;
constexpr int kVolumeSteps = 480;
constexpr int kMaxBubbles = 24;

struct RoundedRect {
    double x, y, width, height, radius;
};

// The vessel is the T: its top bar and two stems. The cursor dash beside the short stem is not part of it.
constexpr RoundedRect kVessel[] = {{0, 0, 56, 16, 8}, {6, 4, 18, 44, 9}, {32, 4, 18, 26, 9}};
constexpr RoundedRect kCursor = {32, 37, 18, 8, 4};

inline double Clamp(double value, double low, double high) {
    return value < low ? low : value > high ? high : value;
}

// Smoothstep of t clamped to [0, 1].
inline double Smooth(double t) {
    const double c = Clamp(t, 0, 1);
    return c * c * (3 - 2 * c);
}

// Horizontal extent of `rect` at height y; false when the line misses it.
inline bool Span(const RoundedRect& rect, double y, double& left, double& right) {
    if (y < rect.y || y > rect.y + rect.height) return false;
    const double upper = rect.y + rect.radius;
    const double lower = rect.y + rect.height - rect.radius;
    double inset = 0;
    if (y < upper || y > lower) {
        const double offset = y < upper ? upper - y : y - lower;
        inset = rect.radius - std::sqrt(std::max(0.0, rect.radius * rect.radius - offset * offset));
    }
    left = rect.x + inset;
    right = rect.x + rect.width - inset;
    return right > left;
}

// Width of the vessel's horizontal cross-section at height y.
inline double Width(double y) {
    double lefts[3] = {};
    double rights[3] = {};
    int count = 0;
    for (const RoundedRect& rect : kVessel) {
        double left = 0, right = 0;
        if (Span(rect, y, left, right)) {
            lefts[count] = left;
            rights[count] = right;
            ++count;
        }
    }
    for (int i = 1; i < count; ++i) {
        for (int j = i; j > 0 && lefts[j] < lefts[j - 1]; --j) {
            std::swap(lefts[j], lefts[j - 1]);
            std::swap(rights[j], rights[j - 1]);
        }
    }
    double total = 0;
    int index = 0;
    while (index < count) {
        const double runLeft = lefts[index];
        double runRight = rights[index];
        int next = index + 1;
        while (next < count && lefts[next] <= runRight) {
            runRight = std::max(runRight, rights[next]);
            ++next;
        }
        total += runRight - runLeft;
        index = next;
    }
    return total;
}

// Whether (x, y) lies inside the vessel.
inline bool Inside(double x, double y) {
    for (const RoundedRect& rect : kVessel) {
        double left = 0, right = 0;
        if (Span(rect, y, left, right) && x >= left && x <= right) return true;
    }
    return false;
}

// Maps a filled volume fraction to the surface height, so the narrow stems fill faster than the wide bar.
class VolumeTable {
public:
    VolumeTable() {
        double sum = 0;
        volume_[kVolumeSteps] = 0;
        for (int step = kVolumeSteps - 1; step >= 0; --step) {
            const double upper = kHeight * step / kVolumeSteps;
            const double lower = kHeight * (step + 1) / kVolumeSteps;
            sum += 0.5 * (Width(upper) + Width(lower)) * (lower - upper);
            volume_[step] = sum;
        }
    }

    // Surface height that holds `fraction` of the vessel's volume: kHeight when empty, 0 when full.
    double Level(double fraction) const {
        const double target = Clamp(fraction, 0, 1) * volume_[0];
        int low = 0;
        int high = kVolumeSteps;
        while (high - low > 1) {
            const int middle = (low + high) / 2;
            if (volume_[middle] >= target) low = middle;
            else high = middle;
        }
        const double span = volume_[low] - volume_[high];
        const double t = span > 0 ? (volume_[low] - target) / span : 0;
        return kHeight * (low + t) / kVolumeSteps;
    }

private:
    double volume_[kVolumeSteps + 1] = {};
};

struct Bubble {
    double x, y, velocity, radius, phase, depth;
    bool live;
};

// Volume inflow, surface waves, and rising bubbles of the water in the vessel.
class Simulation {
public:
    Simulation() : random_(0x9E3779B9u) {}

    // Advance by `seconds` of wall time toward the fill fraction `target`; gaps longer than 0.1 s are shortened.
    void Advance(double seconds, double target) {
        double remaining = Clamp(seconds, 0, 0.1);
        const double goal = Clamp(target, 0, 1);
        while (remaining > 1e-9) {
            const double step = std::min(remaining, 1.0 / 240);
            Step(step, goal);
            remaining -= step;
        }
    }

    // Show the vessel full and still.
    void Settle() {
        fill_ = 1;
        fillVelocity_ = 0;
        for (int i = 0; i < kColumns; ++i) displacement_[i] = velocity_[i] = 0;
        for (Bubble& bubble : bubbles_) bubble.live = false;
    }

    double Fill() const { return fill_; }

    // Rest height of the surface; it rises past the rim while the vessel completes so waves never expose it.
    double Level() const { return volume_.Level(fill_) - 3 * Smooth((fill_ - 0.97) / 0.03); }

    static double ColumnX(int column) { return kWidth * column / (kColumns - 1); }

    // Surface height above `column`, including the ambient swell.
    double SurfaceY(int column) const {
        const double x = ColumnX(column);
        const double swell = 0.34 * std::sin(0.42 * x - 2.1 * time_) + 0.2 * std::sin(0.97 * x + 1.5 * time_ + 1.3);
        return Level() + (displacement_[column] + swell) * (1 - Smooth((fill_ - 0.97) / 0.03));
    }

    // Surface height at x, interpolated between columns.
    double SurfaceAt(double x) const {
        const double position = Clamp(x / Spacing(), 0, kColumns - 1);
        const int column = std::min(static_cast<int>(position), kColumns - 2);
        const double t = position - column;
        return SurfaceY(column) * (1 - t) + SurfaceY(column + 1) * t;
    }

    const Bubble& BubbleAt(int index) const { return bubbles_[index]; }

    // Horizontal position of a bubble, including its wobble.
    static double BubbleX(const Bubble& bubble) { return bubble.x + 0.35 * std::sin(bubble.phase); }

    // Radius of a bubble; it grows while rising because the water pressure drops.
    double BubbleRadius(const Bubble& bubble) const {
        const double depth = bubble.y - Level();
        return bubble.radius * (1 + 0.3 * (1 - Clamp(depth / bubble.depth, 0, 1)));
    }

private:
    static double Spacing() { return kWidth / (kColumns - 1); }

    double Random() {
        random_ ^= random_ << 13;
        random_ ^= random_ >> 17;
        random_ ^= random_ << 5;
        return (random_ >> 8) * (1.0 / 16777216.0);
    }

    // Pushes the surface around x with a smooth bump five columns wide; negative speeds lift it.
    void Kick(double x, double speed) {
        const double weights[] = {0.25, 0.6, 1, 0.6, 0.25};
        const int center = std::min(static_cast<int>(Clamp(x / Spacing() + 0.5, 0, kColumns - 1)), kColumns - 1);
        for (int offset = -2; offset <= 2; ++offset) {
            const int column = center + offset;
            if (column >= 0 && column < kColumns) velocity_[column] += speed * weights[offset + 2];
        }
    }

    // Starts a bubble just above the vessel floor, when that floor lies well below the surface.
    void Spawn(double level) {
        int slot = 0;
        while (slot < kMaxBubbles && bubbles_[slot].live) ++slot;
        if (slot == kMaxBubbles) return;
        const double x = 2 + Random() * (kWidth - 4);
        for (double y = kHeight - 0.5; y > level + 2.5; y -= 0.5) {
            if (!Inside(x, y)) continue;
            const double radius = 0.45 + 0.55 * Random();
            bubbles_[slot] = Bubble{x, y - radius - 0.6, 0, radius, Random() * 6.2831853, y - level, true};
            return;
        }
    }

    void Step(double dt, double target) {
        time_ += dt;
        // The volume follows installation progress through a critically damped spring, so it never runs ahead.
        const double omega = 6;
        fillVelocity_ += (omega * omega * (target - fill_) - 2 * omega * fillVelocity_) * dt;
        fill_ = Clamp(fill_ + fillVelocity_ * dt, 0, 1);
        const double level = Level();
        // Inflow disturbs the surface in proportion to the volume added, plus a slow ambient stir.
        inflow_ += (std::max(0.0, fillVelocity_) * 90 + 0.6) * dt;
        while (inflow_ >= 1) {
            inflow_ -= 1;
            Kick(Random() * kWidth, -(3.5 + 4 * Random()));
        }
        // Damped wave equation: neighbouring columns pull each other, a weak spring flattens, friction dissipates.
        const double coupling = 30.0 * 30.0 / (Spacing() * Spacing());
        for (int i = 0; i < kColumns; ++i) {
            const double left = displacement_[i > 0 ? i - 1 : i];
            const double right = displacement_[i < kColumns - 1 ? i + 1 : i];
            velocity_[i] += (coupling * (left - 2 * displacement_[i] + right) - 10 * displacement_[i] - 3 * velocity_[i]) * dt;
        }
        for (int i = 0; i < kColumns; ++i) displacement_[i] = Clamp(displacement_[i] + velocity_[i] * dt, -2.5, 2.5);
        // Bubbles rise under buoyancy against drag and pop at the surface, which starts a small ripple.
        bubbleClock_ += (fill_ > 0.03 && fill_ < 0.995 ? 2.4 : 0) * dt;
        while (bubbleClock_ >= 1) {
            bubbleClock_ -= 1;
            Spawn(level);
        }
        for (Bubble& bubble : bubbles_) {
            if (!bubble.live) continue;
            bubble.velocity += (-36 - 4.2 * bubble.velocity) * dt;
            bubble.y += bubble.velocity * dt;
            bubble.phase += 9 * dt;
            const double x = BubbleX(bubble);
            if (bubble.y - BubbleRadius(bubble) <= SurfaceAt(x) || !Inside(x, bubble.y)) {
                bubble.live = false;
                Kick(x, -2.5);
            }
        }
    }

    VolumeTable volume_;
    double displacement_[kColumns] = {};
    double velocity_[kColumns] = {};
    Bubble bubbles_[kMaxBubbles] = {};
    double fill_ = 0;
    double fillVelocity_ = 0;
    double time_ = 0;
    double inflow_ = 0;
    double bubbleClock_ = 0;
    std::uint32_t random_;
};

}  // namespace water_fill
