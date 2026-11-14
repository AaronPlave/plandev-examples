@MissionModel(model = Mission.class)
@WithMappers(CommonValueMappers.class)
@WithMappers(BasicValueMappers.class)
@WithConfiguration(Configuration.class)
@WithMetadata(name = "unit", annotation = gov.nasa.ammos.plandev.contrib.metadata.Unit.class)
@WithSubsystem("mobility")
@WithSubsystem("payload")
@WithSubsystem("telecom")
@WithSubsystem("data")

@WithActivityType(Drive.class)
@WithActivityType(Observe.class)
@WithActivityType(Downlink.class)
@WithActivityType(PlaybackData.class)
@WithActivityType(DeleteData.class)

package rover;

import rover.activities.Drive;
import rover.activities.Observe;
import rover.activities.Downlink;
import gov.nasa.ammos.plandev.data.activities.PlaybackData;
import gov.nasa.ammos.plandev.data.activities.DeleteData;
import gov.nasa.ammos.plandev.contrib.serialization.rulesets.BasicValueMappers;
import gov.nasa.ammos.plandev.data.mappers.CommonValueMappers;
import gov.nasa.ammos.plandev.merlin.framework.annotations.MissionModel;
import gov.nasa.ammos.plandev.merlin.framework.annotations.MissionModel.WithActivityType;
import gov.nasa.ammos.plandev.merlin.framework.annotations.MissionModel.WithConfiguration;
import gov.nasa.ammos.plandev.merlin.framework.annotations.MissionModel.WithMappers;
import gov.nasa.ammos.plandev.merlin.framework.annotations.MissionModel.WithMetadata;
import gov.nasa.ammos.plandev.merlin.framework.annotations.MissionModel.WithSubsystem;
