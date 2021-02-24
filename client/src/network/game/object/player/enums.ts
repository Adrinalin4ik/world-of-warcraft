export enum PlayerMovementFlag {
  MOVEFLAG_MOVE_STOP                 = 0x00,			//verified
  MOVEFLAG_MOVE_FORWARD              = 0x01,			//verified
  MOVEFLAG_MOVE_BACKWARD             = 0x02,			//verified
  MOVEFLAG_STRAFE_LEFT               = 0x04,			//verified
  MOVEFLAG_STRAFE_RIGHT              = 0x08,			//verified
  MOVEFLAG_TURN_LEFT                 = 0x10,			//verified
  MOVEFLAG_TURN_RIGHT                = 0x20,			//verified
  MOVEFLAG_PITCH_DOWN                = 0x40,			//Unconfirmed
  MOVEFLAG_PITCH_UP                  = 0x80,			//Unconfirmed
}