from fastapi import Depends, HTTPException, status

from app.models.models import User, UserRole
from app.core.security import get_current_user


def require_role(*roles: UserRole):
    """Dependency: user must have one of the specified roles (admin always passes)."""
    async def _check(current_user: User = Depends(get_current_user)) -> User:
        if current_user.role == UserRole.admin:
            return current_user
        if current_user.role not in roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Insufficient permissions",
            )
        return current_user
    return _check


async def require_admin(current_user: User = Depends(get_current_user)) -> User:
    """Dependency: user must be admin."""
    if current_user.role != UserRole.admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin access required",
        )
    return current_user
