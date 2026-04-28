import type {
    RatingParticipant,
    RatingProgress,
    RatingRoundCompletionReason,
    RatingRoundScope,
    Room,
    SessionRating,
} from "../shared/types";
import { logger } from "../shared/logger";
import * as auth from "./room-auth";

export function addRating(room: Room, discordId: string, username: string, rating: number): boolean {
    if (room.ratingRound?.isClosed) {
        return false;
    }

    if (
        room.ratingRound &&
        !room.ratingRound.expectedVoters.some((user) => user.discordId === discordId)
    ) {
        return false;
    }

    const existingIndex = room.ratings.findIndex((currentRating) => currentRating.discordId === discordId);
    if (existingIndex >= 0) {
        room.ratings[existingIndex].rating = rating;
    } else {
        room.ratings.push({ discordId, username, rating });
    }

    logger.info("Room", `Nota registrada: ${username} deu nota ${rating} na sala ${room.id}`);
    return true;
}

export function getRatings(room: Room): { ratings: SessionRating[]; average: number } {
    if (room.ratings.length === 0) return { ratings: [], average: 0 };

    const sum = room.ratings.reduce((acc, rating) => acc + rating.rating, 0);
    return { ratings: room.ratings, average: Math.round(sum / room.ratings.length * 10) / 10 };
}

export function allUsersRated(room: Room): boolean {
    if (room.ratingRound) {
        if (room.ratingRound.isClosed) return true;
        if (room.ratingRound.expectedVoters.length === 0) return true;

        return room.ratingRound.expectedVoters.every((user) =>
            room.ratings.some((rating) => rating.discordId === user.discordId)
        );
    }

    const connectedUsers = auth.getConnectedUsers(room);
    if (connectedUsers.length === 0) return true;

    return connectedUsers.every((user) => room.ratings.some((rating) => rating.discordId === user.discordId));
}

export function startRatingRound(room: Room, scope: RatingRoundScope, durationMs: number): RatingProgress {
    if (room.ratingRound && !room.ratingRound.isClosed) {
        return getRatingProgress(room)!;
    }

    const now = Date.now();
    const expectedVoters = auth.getConnectedUsers(room).map((user) => ({
        discordId: user.discordId,
        username: user.username,
    }));

    room.ratings = [];
    room.ratingRound = {
        scope,
        startedAt: now,
        expiresAt: now + durationMs,
        expectedVoters,
        isClosed: false,
    };

    return getRatingProgress(room)!;
}

export function getRatingProgress(room: Room): RatingProgress | null {
    const ratingRound = room.ratingRound;
    if (!ratingRound) return null;

    const { ratings, average } = getRatings(room);

    return {
        scope: ratingRound.scope,
        startedAt: ratingRound.startedAt,
        expiresAt: ratingRound.expiresAt,
        isClosed: ratingRound.isClosed,
        completionReason: ratingRound.completionReason,
        participants: buildRatingParticipants(room),
        ratings,
        average,
    };
}

export function isRatingRoundParticipant(room: Room, discordId: string): boolean {
    if (!room.ratingRound) return false;
    return room.ratingRound.expectedVoters.some((user) => user.discordId === discordId);
}

export function finishRatingRound(
    room: Room,
    completionReason: RatingRoundCompletionReason
): RatingProgress | null {
    if (!room.ratingRound) return null;

    room.ratingRound.isClosed = true;
    room.ratingRound.completionReason = completionReason;

    return getRatingProgress(room);
}

export function clearRatingRound(room: Room): void {
    room.ratingRound = undefined;
}

function buildRatingParticipants(room: Room): RatingParticipant[] {
    if (!room.ratingRound) return [];

    return room.ratingRound.expectedVoters.map((user) => {
        const rating = room.ratings.find((currentRating) => currentRating.discordId === user.discordId);

        if (rating) {
            return {
                discordId: user.discordId,
                username: rating.username || user.username,
                rating: rating.rating,
                status: "rated",
            };
        }

        return {
            discordId: user.discordId,
            username: user.username,
            rating: null,
            status: room.ratingRound?.isClosed ? "timed_out" : "pending",
        };
    });
}
